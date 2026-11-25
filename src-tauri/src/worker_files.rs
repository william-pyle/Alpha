use serde_json::{json, Value};
use std::path::Path;

pub(super) fn response(request: Value, workspace: &Path) -> Value {
    let id = &request["requestId"];
    #[cfg(windows)]
    let result = windows::perform(&request, workspace);
    #[cfg(not(windows))]
    let result: Result<Value, (u16, &'static str)> = {
        let _ = workspace;
        Err((503, "Worker file requests require the Windows desktop app."))
    };
    match result {
        Ok(value) => json!({"type": "worker-file-operation", "requestId": id, "result": value}),
        Err(failure) => {
            let (status, error) = failure;
            let mut reply = json!({"type": "worker-file-operation", "requestId": id, "status": status, "error": error});
            #[cfg(windows)]
            {
                let read_only =
                    matches!(request["action"].as_str(), Some("inspect" | "inspect-copy"));
                if let Some(access) = windows::access_reason(failure, read_only) {
                    reply["access"] = json!(access);
                }
            }
            #[cfg(not(windows))]
            {
                reply["access"] = json!("host-unavailable");
            }
            reply
        }
    }
}

#[cfg(windows)]
pub(crate) mod windows {
    use super::*;
    use crate::shared_drive::windows_files::{
        file_identity, identity, lock_local_tree, open_original, revision, validate_attributes,
        Failure, Outcome, FILE_IN_USE, NO_RECALL, OS_ACCESS_DENIED,
    };
    use ::windows::{
        core::PCWSTR,
        Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileDispositionInfo, FileRenameInfo, GetDriveTypeW, SetFileInformationByHandle,
                DELETE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM, FILE_DISPOSITION_INFO,
                FILE_GENERIC_WRITE, FILE_RENAME_INFO,
            },
        },
    };
    use std::{
        fs::{self, File, OpenOptions},
        io::{self, Read, Seek, SeekFrom, Write},
        mem::{offset_of, size_of, size_of_val},
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
        path::PathBuf,
        ptr::addr_of_mut,
    };

    const DENIED: Failure = (403, "This file is outside the approved Markdown boundary.");
    const STALE: Failure = (
        409,
        "The approved file or destination changed. Review it again.",
    );
    const IO_FAILED: Failure = (503, "Windows could not finish the approved file operation.");
    const LIMIT: u64 = 128 * 1024;

    pub(crate) fn access_reason(failure: Failure, read_only: bool) -> Option<&'static str> {
        match failure {
            OS_ACCESS_DENIED => Some("os-permission"),
            FILE_IN_USE if read_only => Some("recoverable-host"),
            FILE_IN_USE => Some("unknown-outcome"),
            (403, _) => Some("policy"),
            (503, _) if read_only => Some("host-unavailable"),
            (503, _) => Some("unknown-outcome"),
            _ => None,
        }
    }

    pub(crate) fn os_failure(error: &io::Error) -> Option<Failure> {
        match error.raw_os_error() {
            Some(5 | 19 | 1260 | 1314) => Some(OS_ACCESS_DENIED),
            Some(32 | 33) => Some(FILE_IN_USE),
            _ if error.kind() == io::ErrorKind::PermissionDenied => Some(OS_ACCESS_DENIED),
            _ => None,
        }
    }

    fn io_failure(error: io::Error) -> Failure {
        os_failure(&error).unwrap_or(IO_FAILED)
    }

    fn filename(value: &Value) -> Outcome<&str> {
        let filename = value.as_str().ok_or(DENIED)?;
        let lowered = filename.to_ascii_lowercase();
        let stem = lowered.strip_suffix(".md").ok_or(DENIED)?;
        if stem.is_empty()
            || stem.len() > 80
            || !stem.as_bytes()[0].is_ascii_alphanumeric()
            || !stem
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || matches!(stem, "agents" | "con" | "prn" | "aux" | "nul")
            || (stem.len() == 4
                && (stem.starts_with("com") || stem.starts_with("lpt"))
                && stem.as_bytes()[3].is_ascii_digit())
            || [
                "secret",
                "credential",
                "password",
                "token",
                "oauth",
                "signing",
                "privatekey",
                "private_key",
                "private-key",
                "apikey",
                "api_key",
                "api-key",
            ]
            .iter()
            .any(|part| stem.contains(part))
            || stem.split(['-', '_']).any(|part| part == "auth")
        {
            return Err(DENIED);
        }
        Ok(filename)
    }

    pub(crate) fn workspace_root(root: &Path, project: &Value) -> Outcome<PathBuf> {
        let id = project.as_str().ok_or(DENIED)?;
        if id.is_empty()
            || id.len() > 100
            || id == "mooseville"
            || id.as_bytes()[0] == b'-'
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(DENIED);
        }
        let drive = root.ancestors().last().ok_or(DENIED)?;
        let wide: Vec<u16> = drive.as_os_str().encode_wide().chain([0]).collect();
        // DRIVE_FIXED only. Device, UNC, mapped network and removable drives
        // are outside this deliberately bounded host operation.
        if wide.len() != 4 || unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) } != 3 {
            return Err(DENIED);
        }
        Ok(root.join("projects").join(id).join("workspace"))
    }

    pub(crate) fn protect_workspace(root: &Path) -> Outcome<()> {
        for ancestor in root.ancestors() {
            match fs::symlink_metadata(ancestor.join(".git")) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(os_failure(&error).unwrap_or(DENIED)),
                Ok(_) => return Err(DENIED),
            }
        }
        Ok(())
    }

    fn read_markdown(file: &mut File) -> Outcome<Vec<u8>> {
        let metadata = file.metadata().map_err(io_failure)?;
        if metadata.file_attributes() & (FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0) != 0 {
            return Err(DENIED);
        }
        if metadata.len() > LIMIT {
            return Err((
                413,
                "The registered Markdown file exceeds the worker file limit.",
            ));
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(io_failure)?;
        if bytes.len() as u64 > LIMIT {
            return Err((
                413,
                "The registered Markdown file exceeds the worker file limit.",
            ));
        }
        let text =
            std::str::from_utf8(&bytes).map_err(|_| (415, "The report is not valid UTF-8."))?;
        if text.contains('\0') {
            return Err((415, "The report is not valid plain text."));
        }
        if text
            .lines()
            .any(|line| line.contains("-----BEGIN ") && line.contains("PRIVATE KEY-----"))
        {
            return Err(DENIED);
        }
        Ok(bytes)
    }

    fn final_newline(bytes: &[u8]) -> &'static [u8] {
        if bytes.is_empty() || bytes.ends_with(b"\n") {
            b""
        } else if bytes.ends_with(b"\r") || !bytes.windows(2).any(|window| window == b"\r\n") {
            b"\n"
        } else {
            b"\r\n"
        }
    }

    fn append_newline(file: &mut File, bytes: &[u8], edit: &Value) -> Outcome<()> {
        if edit.as_str() != Some("ensure-final-newline") {
            return Err(DENIED);
        }
        let suffix = final_newline(bytes);
        if suffix.is_empty() {
            return Ok(());
        }
        if (bytes.len() + suffix.len()) as u64 > LIMIT {
            return Err((413, "The result exceeds the worker file limit."));
        }
        // Existing bytes are never overwritten. If an append fails, only the
        // inserted suffix can be incomplete, even after a process or host stop.
        let original_size = bytes.len() as u64;
        if file.seek(SeekFrom::End(0)).map_err(io_failure)? != original_size {
            return Err(STALE);
        }
        if let Err(error) = file.write_all(suffix).and_then(|_| file.sync_all()) {
            if file
                .set_len(original_size)
                .and_then(|_| file.sync_all())
                .is_err()
            {
                return Err((503, "Windows could not confirm the final newline. Review the report before retrying."));
            }
            return Err(io_failure(error));
        }
        Ok(())
    }

    fn destination_revision(destination: &Path, root: &File, name: &str) -> Outcome<String> {
        match fs::symlink_metadata(destination) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(revision(
                &file_identity(root, false)?,
                name.to_ascii_lowercase().as_bytes(),
            )),
            Err(error) => Err(io_failure(error)),
            Ok(_) => Err((
                409,
                "The destination already exists. Alpha will not overwrite it.",
            )),
        }
    }

    pub(crate) fn remove_stage(stage: &File) {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        // Remove our exact handle on failure, even if its name has changed.
        let _ = unsafe {
            SetFileInformationByHandle(
                HANDLE(stage.as_raw_handle()),
                FileDispositionInfo,
                &disposition as *const _ as *const _,
                size_of_val(&disposition) as u32,
            )
        };
    }

    pub(crate) fn rename_new(stage: &File, destination: &Path) -> Outcome<()> {
        let filename: Vec<u16> = destination.as_os_str().encode_wide().chain([0]).collect();
        let filename_offset = offset_of!(FILE_RENAME_INFO, FileName);
        let bytes =
            (filename_offset + size_of_val(filename.as_slice())).max(size_of::<FILE_RENAME_INFO>());
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let settings = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        // The flexible buffer starts aligned and zeroed. Default flags mean
        // never replace, RootDirectory is null and FileName is an absolute path.
        unsafe {
            (*settings).FileNameLength = ((filename.len() - 1) * size_of::<u16>()) as u32;
            addr_of_mut!((*settings).FileName)
                .cast::<u16>()
                .copy_from_nonoverlapping(filename.as_ptr(), filename.len());
            SetFileInformationByHandle(
                HANDLE(stage.as_raw_handle()),
                FileRenameInfo,
                settings.cast(),
                bytes as u32,
            )
            .map_err(|error| match error.code().0 as u32 & 0xffff {
                80 | 183 => STALE,
                5 | 19 | 1260 | 1314 => OS_ACCESS_DENIED,
                32 | 33 => FILE_IN_USE,
                _ => IO_FAILED,
            })
        }
    }

    pub(crate) fn write_new(stage_path: &Path, destination: &Path, bytes: &[u8]) -> Outcome<()> {
        let mut stage = OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(FILE_GENERIC_WRITE.0 | DELETE.0)
            .share_mode(0)
            .custom_flags(NO_RECALL)
            .open(stage_path)
            .map_err(io_failure)?;
        let perform = (|| {
            validate_attributes(&stage, false)?;
            identity(&stage)?;
            stage
                .write_all(bytes)
                .and_then(|_| stage.sync_all())
                .map_err(io_failure)?;
            rename_new(&stage, destination)
        })();
        if perform.is_err() {
            remove_stage(&stage);
        }
        perform
    }

    pub(super) fn perform(request: &Value, workspace: &Path) -> Outcome<Value> {
        let action = request["action"].as_str().ok_or(DENIED)?;
        if !matches!(action, "inspect" | "inspect-copy" | "copy" | "modify") {
            return Err(DENIED);
        }
        let filename = filename(&request["filename"])?;
        let root = workspace_root(workspace, &request["projectId"])?;
        let (mut source, _source_locks) =
            open_original(root.to_str().ok_or(DENIED)?, filename, action == "modify")?;
        protect_workspace(&root)?;
        let source_identity = identity(&source)?;
        let bytes = read_markdown(&mut source)?;
        let source_revision = revision(&source_identity, &bytes);
        if action == "inspect" {
            return Ok(json!({"revision": source_revision}));
        }
        if request["expectedRevision"].as_str() != Some(&source_revision) {
            return Err(STALE);
        }
        if action == "modify" {
            append_newline(&mut source, &bytes, &request["edit"])?;
            return Ok(json!({"applied": true}));
        }
        if request["projectId"] == request["destinationProjectId"] {
            return Err(DENIED);
        }
        let root = workspace_root(workspace, &request["destinationProjectId"])?;
        let (root, destination_locks) = lock_local_tree(&root)?;
        protect_workspace(&root)?;
        let destination = root.join(filename);
        let destination_revision = destination_revision(
            &destination,
            destination_locks.last().ok_or(DENIED)?,
            filename,
        )?;
        if action == "inspect-copy" {
            return Ok(json!({"destinationRevision": destination_revision}));
        }
        if request["destinationRevision"].as_str() != Some(&destination_revision) {
            return Err(STALE);
        }
        let request_id = request["requestId"]
            .as_str()
            .filter(|id| id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-'))
            .ok_or(DENIED)?;
        let stage = root.join(format!(".alpha-copy-{request_id}.tmp"));
        write_new(&stage, &destination, &bytes)?;
        Ok(json!({"applied": true}))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            os::windows::fs::symlink_file,
            time::{SystemTime, UNIX_EPOCH},
        };

        struct Fixture(PathBuf);

        impl Fixture {
            fn new() -> Self {
                let name = format!(
                    "alpha-worker-files-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                );
                let this = Self(std::env::temp_dir().join(name));
                fs::create_dir_all(this.project("source")).unwrap();
                fs::create_dir_all(this.project("destination")).unwrap();
                this
            }
            fn project(&self, id: &str) -> PathBuf {
                self.0.join("projects").join(id).join("workspace")
            }
            fn run(&self, action: &str, name: &str) -> Value {
                json!({"action": action, "projectId": "source", "filename": name,
                    "requestId": "00000000-0000-0000-0000-000000000000"})
            }
            fn inspect(&self, name: &str) -> String {
                perform(&self.run("inspect", name), &self.0).unwrap()["revision"]
                    .as_str()
                    .unwrap()
                    .into()
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn native_shared_handle_contention_can_recover_only_during_inspection() {
            let fixture = Fixture::new();
            let source = fixture.project("source").join("notes.md");
            fs::write(&source, b"fixture notes").unwrap();
            let held = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&source)
                .unwrap();
            let packet = super::super::response(fixture.run("inspect", "notes.md"), &fixture.0);
            assert_eq!(packet["access"], "recoverable-host");
            let packet = super::super::response(fixture.run("modify", "notes.md"), &fixture.0);
            assert_eq!(packet["access"], "unknown-outcome");
            drop(held);
            assert_eq!(fixture.inspect("notes.md").len(), 64);
            assert_eq!(fs::read(&source).unwrap(), b"fixture notes");
            assert_eq!(
                access_reason(os_failure(&io::Error::from_raw_os_error(5)).unwrap(), false),
                Some("os-permission")
            );
        }

        #[test]
        fn exact_copy_publishes_without_overwrite_or_private_bytes_in_response() {
            let fixture = Fixture::new();
            let source = fixture.project("source").join("notes.md");
            let destination = fixture.project("destination").join("notes.md");
            fs::write(&source, b"fixture private document").unwrap();
            let mut request = fixture.run("inspect-copy", "notes.md");
            request["destinationProjectId"] = json!("destination");
            request["expectedRevision"] = json!(fixture.inspect("notes.md"));
            let review = perform(&request, &fixture.0).unwrap();
            assert_eq!(review.as_object().unwrap().len(), 1);
            request["action"] = json!("copy");
            request["destinationRevision"] = review["destinationRevision"].clone();
            assert_eq!(
                perform(&request, &fixture.0).unwrap(),
                json!({"applied":true})
            );
            assert_eq!(fs::read(&destination).unwrap(), b"fixture private document");
            assert_eq!(
                fs::read_dir(fixture.project("destination"))
                    .unwrap()
                    .count(),
                1
            );
            fs::write(&destination, b"existing content").unwrap();
            assert_eq!(perform(&request, &fixture.0).unwrap_err().0, 409);
            assert_eq!(fs::read(&destination).unwrap(), b"existing content");
        }

        #[test]
        fn stale_sources_destinations_and_edits_fail_closed() {
            let fixture = Fixture::new();
            let source = fixture.project("source").join("notes.md");
            fs::write(&source, b"first draft").unwrap();
            let mut request = fixture.run("inspect-copy", "notes.md");
            request["destinationProjectId"] = json!("destination");
            request["expectedRevision"] = json!(fixture.inspect("notes.md"));
            request["destinationRevision"] =
                perform(&request, &fixture.0).unwrap()["destinationRevision"].clone();
            let prior_destination = fixture.0.join("previous-workspace");
            fs::rename(fixture.project("destination"), prior_destination).unwrap();
            fs::create_dir(fixture.project("destination")).unwrap();
            request["action"] = json!("copy");
            assert_eq!(perform(&request, &fixture.0).unwrap_err().0, 409);
            assert_eq!(
                fs::read_dir(fixture.project("destination"))
                    .unwrap()
                    .count(),
                0
            );
            fs::write(&source, b"second draft").unwrap();
            request["action"] = json!("modify");
            request["edit"] = json!("ensure-final-newline");
            assert_eq!(perform(&request, &fixture.0).unwrap_err().0, 409);
            request["expectedRevision"] = json!(fixture.inspect("notes.md"));
            assert_eq!(
                perform(&request, &fixture.0).unwrap(),
                json!({"applied":true})
            );
            assert_eq!(fs::read(&source).unwrap(), b"second draft\n");
            assert_eq!(final_newline(b"line\r\nend"), b"\r\n");
            assert_eq!(final_newline(b"line\r\nend\r"), b"\n");
            assert_eq!(final_newline(b""), b"");
            assert_eq!(final_newline(b"line\n"), b"");
            request["expectedRevision"] = json!(fixture.inspect("notes.md"));
            request["edit"] = json!("trim-trailing-whitespace");
            assert_eq!(perform(&request, &fixture.0).unwrap_err().0, 403);
            assert_eq!(fs::read(&source).unwrap(), b"second draft\n");
        }

        #[test]
        fn rejects_traversal_credentials_runtime_and_link_aliases() {
            let fixture = Fixture::new();
            for name in [
                "../notes.md",
                "nested/notes.md",
                "report.md:stream",
                ".env.md",
                "credentials.md",
                "AGENTS.md",
                "NUL.md",
                "notes.md.",
            ] {
                assert_eq!(
                    perform(&fixture.run("inspect", name), &fixture.0)
                        .unwrap_err()
                        .0,
                    403
                );
            }
            let outside = fixture.0.join("outside.md");
            let hard = fixture.project("source").join("hardlink.md");
            fs::write(&outside, b"outside text").unwrap();
            fs::hard_link(&outside, &hard).unwrap();
            assert_eq!(
                perform(&fixture.run("inspect", "hardlink.md"), &fixture.0)
                    .unwrap_err()
                    .0,
                403
            );
            let link = fixture.project("source").join("linked.md");
            if symlink_file(&outside, &link).is_ok() {
                assert_eq!(
                    perform(&fixture.run("inspect", "linked.md"), &fixture.0)
                        .unwrap_err()
                        .0,
                    403
                );
            } else {
                eprintln!("Windows symlink creation unavailable; hardlink and junction checks remain active.");
            }
            fs::write(
                fixture.project("source").join("notes.md"),
                b"-----BEGIN TEST PRIVATE KEY-----",
            )
            .unwrap();
            assert_eq!(
                perform(&fixture.run("inspect", "notes.md"), &fixture.0)
                    .unwrap_err()
                    .0,
                403
            );
            fs::write(
                fixture.project("source").join("notes.md"),
                b"allowed direct report",
            )
            .unwrap();
            fs::remove_dir(&fixture.project("destination")).unwrap();
            let junction = fixture.project("destination");
            let output = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&junction)
                .arg(fixture.project("source"))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated fixture could not create its test junction"
            );
            let mut redirected = fixture.run("inspect", "notes.md");
            redirected["projectId"] = json!("destination");
            assert_eq!(perform(&redirected, &fixture.0).unwrap_err().0, 403);
            fs::remove_dir(junction).unwrap();
        }
    }
}
