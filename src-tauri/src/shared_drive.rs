use serde_json::{json, Value};

pub(super) fn response(request: Value) -> Value {
    let id = &request["requestId"];
    let mut reply = json!({"type": "shared-drive-original", "requestId": id});
    if request["action"] == "status" {
        reply["result"] = json!({"available": cfg!(windows)});
        return reply;
    }
    #[cfg(windows)]
    match windows_files::perform(&request) {
        Ok(result) => reply["result"] = result,
        Err((status, error)) => {
            reply["status"] = json!(status);
            reply["error"] = json!(error);
        }
    }
    #[cfg(not(windows))]
    {
        reply["status"] = json!(503);
        reply["error"] = json!("Shared Drive original access requires the Windows desktop app.");
    }
    reply
}

#[cfg(windows)]
mod windows_files {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use sha2::{Digest, Sha256};
    use std::{
        fs::{File, OpenOptions},
        io::{self, Read, Seek, SeekFrom, Write},
        os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
        path::{Component, Path, PathBuf, Prefix},
    };
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_NO_RECALL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        },
    };

    type Failure = (u16, &'static str);
    type Outcome<T> = Result<T, Failure>;
    const TEXT_LIMIT: u64 = 128 * 1024;
    const IMAGE_LIMIT: u64 = 8 * 1024 * 1024;
    const UNSAFE_PATH: Failure = (
        403,
        "Shared Drive does not open linked or redirected files.",
    );
    const INVALID_PATH: Failure = (400, "Choose a file inside Shared Drive.");
    const OFFLINE: Failure = (
        409,
        "This original is offline or needs cloud recall. Open it in Explorer when available.",
    );
    const NO_RECALL: u32 = FILE_FLAG_OPEN_NO_RECALL.0 | FILE_FLAG_OPEN_REPARSE_POINT.0;

    fn io_failure(error: io::Error) -> Failure {
        match error.raw_os_error() {
            Some(2 | 3) => (404, "The original or its folder is unavailable. It was not created."),
            Some(5 | 19) => (403, "Windows denied access to the original."),
            Some(32 | 33) => (409, "The original is in use. Review it before trying again."),
            Some(4350) => OFFLINE,
            _ => (503, "Shared Drive could not open the original. Review it in Explorer before trying again."),
        }
    }

    fn component_allowed(name: &str) -> bool {
        if name.is_empty()
            || name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            return false;
        }
        let device = name
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end()
            .to_ascii_uppercase();
        !matches!(
            device.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) && !device
            .strip_prefix("COM")
            .or_else(|| device.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(
                    suffix,
                    "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
    }

    fn validate_attributes(file: &File, directory: bool) -> Outcome<()> {
        let info = file.metadata().map_err(io_failure)?;
        validate_flags(info.file_attributes())?;
        if (directory && !info.is_dir()) || (!directory && !info.is_file()) {
            return Err(INVALID_PATH);
        }
        Ok(())
    }

    fn validate_flags(flags: u32) -> Outcome<()> {
        // Windows OFFLINE, RECALL_ON_OPEN and RECALL_ON_DATA_ACCESS.
        if flags & (0x1000 | 0x40000 | 0x400000) != 0 {
            return Err(OFFLINE);
        }
        if flags & 0x400 != 0 {
            return Err(UNSAFE_PATH);
        }
        Ok(())
    }

    fn lock_directory(path: &Path) -> Outcome<File> {
        // Hold each verified ancestor without SHARE_DELETE for the full operation.
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(NO_RECALL | FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
            .map_err(io_failure)?;
        validate_attributes(&file, true)?;
        Ok(file)
    }

    fn open_original(root: &str, relative: &str, writing: bool) -> Outcome<(File, Vec<File>)> {
        let parts: Vec<_> = relative.split(['/', '\\']).collect();
        if relative.len() > 4096 || parts.iter().any(|part| !component_allowed(part)) {
            return Err(INVALID_PATH);
        }
        let mut components = Path::new(root).components();
        let Some(Component::Prefix(drive)) = components.next() else {
            return Err(INVALID_PATH);
        };
        if !matches!(drive.kind(), Prefix::Disk(_)) || components.next() != Some(Component::RootDir)
        {
            return Err(INVALID_PATH);
        }
        let mut path = PathBuf::from(drive.as_os_str());
        path.push("\\");
        let mut locks = vec![lock_directory(&path)?];
        for part in components {
            let Component::Normal(name) = part else {
                return Err(INVALID_PATH);
            };
            if !name.to_str().is_some_and(component_allowed) {
                return Err(INVALID_PATH);
            }
            path.push(name);
            locks.push(lock_directory(&path)?);
        }
        for part in &parts[..parts.len() - 1] {
            path.push(part);
            locks.push(lock_directory(&path)?);
        }
        path.push(parts.last().ok_or(INVALID_PATH)?);
        // Check metadata without recalling the file and keep the name pinned.
        let probe = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(NO_RECALL)
            .open(&path)
            .map_err(io_failure)?;
        validate_attributes(&probe, false)?;
        let file = OpenOptions::new()
            .read(true)
            .write(writing)
            .share_mode(if writing { 0 } else { FILE_SHARE_READ.0 })
            .custom_flags(NO_RECALL)
            .open(path)
            .map_err(io_failure)?;
        validate_attributes(&file, false)?;
        Ok((file, locks))
    }

    fn identity(file: &File) -> Outcome<[u8; 12]> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
            .map_err(|_| (503, "Windows could not verify the original file."))?;
        if info.nNumberOfLinks != 1 {
            return Err(UNSAFE_PATH);
        }
        let mut id = [0; 12];
        id[..4].copy_from_slice(&info.dwVolumeSerialNumber.to_le_bytes());
        id[4..8].copy_from_slice(&info.nFileIndexHigh.to_le_bytes());
        id[8..].copy_from_slice(&info.nFileIndexLow.to_le_bytes());
        Ok(id)
    }

    fn revision(id: &[u8; 12], bytes: &[u8]) -> String {
        let mut digest = Sha256::new();
        digest.update(id);
        digest.update(bytes);
        format!("{:x}", digest.finalize())
    }

    fn mime(bytes: &[u8], extension: &str) -> Outcome<&'static str> {
        match extension {
            "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok("image/png"),
            "jpg" | "jpeg" if bytes.starts_with(b"\xff\xd8\xff") => Ok("image/jpeg"),
            "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
                Ok("image/gif")
            }
            "bmp" if bytes.starts_with(b"BM") => Ok("image/bmp"),
            "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
                Ok("image/webp")
            }
            _ => Err((415, "This original is not a supported raster image.")),
        }
    }

    fn replace_contents(file: &mut File, bytes: &[u8]) -> io::Result<()> {
        file.seek(SeekFrom::Start(0))?;
        file.write_all(bytes)?;
        file.set_len(bytes.len() as u64)?;
        file.sync_all()
    }

    pub(super) fn perform(request: &Value) -> Outcome<Value> {
        let root = request["root"].as_str().ok_or(INVALID_PATH)?;
        let relative = request["relativePath"].as_str().ok_or(INVALID_PATH)?;
        let action = request["action"].as_str().unwrap_or_default();
        let extension = Path::new(relative)
            .extension()
            .and_then(|part| part.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let limit = match action {
            "image"
                if matches!(
                    extension.as_str(),
                    "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
                ) =>
            {
                IMAGE_LIMIT
            }
            "text"
                if matches!(
                    extension.as_str(),
                    "txt" | "md" | "csv" | "tsv" | "log" | "json" | "ini" | "yaml" | "yml"
                ) =>
            {
                TEXT_LIMIT
            }
            "save" if extension == "txt" => TEXT_LIMIT,
            _ => {
                return Err((
                    400,
                    "This action or file type is unavailable in Shared Drive.",
                ))
            }
        };
        let (mut file, _ancestors) = open_original(root, relative, action == "save")?;
        let id = identity(&file)?;
        if file.metadata().map_err(io_failure)?.len() > limit {
            return Err((413, "This original is too large to open in Alpha."));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(io_failure)?;
        if bytes.len() as u64 > limit {
            return Err((413, "This original is too large to open in Alpha."));
        }
        if action == "image" {
            return Ok(json!({"mime": mime(&bytes, &extension)?, "data": STANDARD.encode(&bytes)}));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| (415, "Only UTF-8 plain text is supported."))?;
        if text.contains('\0') {
            return Err((415, "Only UTF-8 plain text is supported."));
        }
        let current = revision(&id, &bytes);
        if action == "text" {
            return Ok(json!({"text": text, "revision": current}));
        }
        let next = request["text"]
            .as_str()
            .filter(|text| text.len() as u64 <= limit && !text.contains('\0'))
            .ok_or((400, "Choose UTF-8 plain text within the size limit."))?;
        if request["revision"].as_str() != Some(&current) {
            return Err((
                409,
                "The original changed. Your draft is kept. Review the new original before saving.",
            ));
        }
        if next.as_bytes() != bytes && replace_contents(&mut file, next.as_bytes()).is_err() {
            let restored = replace_contents(&mut file, &bytes).is_ok();
            return Err((
                503,
                if restored {
                    "Save failed. The original was restored and your draft is kept."
                } else {
                    "Save failed and the original could not be restored. Your draft is kept. Inspect the original in Explorer."
                },
            ));
        }
        Ok(json!({"revision": revision(&id, next.as_bytes())}))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            process::Command,
            time::{SystemTime, UNIX_EPOCH},
        };

        struct Fixture(PathBuf);
        impl Fixture {
            fn new() -> Self {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let root = std::env::temp_dir()
                    .join(format!("alpha-drive-test-{}-{now}", std::process::id()));
                fs::create_dir_all(root.join("nested")).unwrap();
                Self(root)
            }
            fn request(&self, action: &str, name: &str) -> Value {
                json!({"root": self.0, "relativePath": name, "action": action})
            }
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn reads_raster_and_text_and_saves_only_existing_txt_at_the_read_revision() {
            let fixture = Fixture::new();
            let original = fixture.0.join("nested/Notes.TXT");
            fs::write(&original, "Original π").unwrap();
            fs::write(fixture.0.join("nested/info.md"), "<text>").unwrap();
            fs::write(fixture.0.join("nested/preview.png"), b"\x89PNG\r\n\x1a\n").unwrap();
            fs::write(fixture.0.join("nested/invalid.png"), "text").unwrap();
            assert_eq!(
                perform(&fixture.request("text", "nested/info.md")).unwrap()["text"],
                "<text>"
            );
            assert_eq!(
                perform(&fixture.request("image", "nested/preview.png")).unwrap()["mime"],
                "image/png"
            );
            assert_eq!(
                perform(&fixture.request("image", "nested/invalid.png"))
                    .unwrap_err()
                    .0,
                415
            );
            assert_eq!(
                perform(&fixture.request("save", "nested/info.md"))
                    .unwrap_err()
                    .0,
                400
            );
            let read = perform(&fixture.request("text", "nested/Notes.TXT")).unwrap();
            assert_eq!(read["text"], "Original π");
            let mut edit = fixture.request("save", "nested/Notes.TXT");
            edit["revision"] = read["revision"].clone();
            edit["text"] = json!("New ∆");
            let saved = perform(&edit).unwrap();
            assert_ne!(saved["revision"], read["revision"]);
            assert_eq!(fs::read_to_string(&original).unwrap(), "New ∆");
            fs::write(&original, "External edit").unwrap();
            edit["revision"] = saved["revision"].clone();
            assert_eq!(perform(&edit).unwrap_err().0, 409);
            assert_eq!(fs::read_to_string(&original).unwrap(), "External edit");
            fs::remove_file(&original).unwrap();
            assert_eq!(perform(&edit).unwrap_err().0, 404);
            assert!(!original.exists());
        }

        #[test]
        fn denies_traversal_recall_attributes_hard_links_and_junctions() {
            let fixture = Fixture::new();
            let external = Fixture::new();
            let target = external.0.join("outside.txt");
            fs::write(&target, "Do not access").unwrap();
            for name in [
                "../outside.txt",
                "/outside.txt",
                "C:\\outside.txt",
                "nested/../outside.txt",
                "nested/NUL.txt",
                "nested/file.txt:stream",
            ] {
                assert_eq!(
                    perform(&fixture.request("text", name)).unwrap_err().0,
                    400,
                    "{name}"
                );
            }
            for flags in [0x1000, 0x40000, 0x400000] {
                assert_eq!(validate_flags(flags), Err(OFFLINE));
            }
            fs::hard_link(&target, fixture.0.join("hard.txt")).unwrap();
            assert_eq!(
                perform(&fixture.request("text", "hard.txt")).unwrap_err().0,
                403
            );
            let junction = fixture.0.join("junction");
            let result = Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(&junction)
                .arg(&external.0)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "Synthetic junction creation failed."
            );
            assert_eq!(
                perform(&fixture.request("text", "junction/outside.txt"))
                    .unwrap_err()
                    .0,
                403
            );
            assert_eq!(fs::read_to_string(target).unwrap(), "Do not access");
        }
    }
}
