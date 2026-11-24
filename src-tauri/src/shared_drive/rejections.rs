use super::windows_files::{
    component_allowed, identity, lock_directory, lock_local_tree, validate_attributes, Outcome,
    NO_RECALL,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::OwnedHandle},
    path::{Component, Path, Prefix},
    ptr,
};
use windows::Win32::Storage::FileSystem::{
    GetDriveTypeW, MoveFileExW, FILE_SHARE_READ, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows_sys::Win32::{
    Foundation::{HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0},
    System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
};

const DIRECTORY: &str = ".alpha-shared-drive";
const FILENAME: &str = "rejections.json";
const VERSION: u32 = 1;
const LIMIT: u64 = 8 * 1024 * 1024;
const UNAVAILABLE: (u16, &str) = (503, "Shared Drive rejection state is unavailable.");
const INVALID_INPUT: (u16, &str) = (
    400,
    "Choose a Shared Drive relative file path and a rejection value.",
);

struct StoreLock(OwnedHandle);

impl StoreLock {
    fn acquire() -> Outcome<Self> {
        use std::os::windows::io::FromRawHandle;

        // Native requests run on different threads. One OS mutex also protects
        // against another host process using the same private Workspace.
        let name: Vec<u16> = "Global\\com.jazcosolutions.alpha.shared-drive-rejections-v1\0"
            .encode_utf16()
            .collect();
        let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(UNAVAILABLE);
        }
        let owned = unsafe { OwnedHandle::from_raw_handle(handle) };
        match unsafe { WaitForSingleObject(handle, 5_000) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(owned)),
            _ => Err(UNAVAILABLE),
        }
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;

        unsafe { ReleaseMutex(self.0.as_raw_handle() as HANDLE) };
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    rejections: Vec<String>,
}

fn normalized(relative: &str) -> Option<String> {
    if relative.encode_utf16().count() > 1024 || !relative.split(['/', '\\']).all(component_allowed)
    {
        return None;
    }
    Some(relative.replace('\\', "/"))
}

fn require_local_drive(workspace: &Path) -> Outcome<()> {
    let Some(Component::Prefix(prefix)) = workspace.components().next() else {
        return Err(UNAVAILABLE);
    };
    let Prefix::Disk(drive) = prefix.kind() else {
        return Err(UNAVAILABLE);
    };
    let root = [u16::from(drive), u16::from(b':'), u16::from(b'\\'), 0];
    // DRIVE_REMOVABLE, DRIVE_FIXED, DRIVE_RAMDISK. A mapped network drive
    // uses a drive letter too, but is not a local store.
    match unsafe { GetDriveTypeW(windows::core::PCWSTR(root.as_ptr())) } {
        2 | 3 | 6 => Ok(()),
        _ => Err(UNAVAILABLE),
    }
}

fn load(file: &Path) -> Outcome<State> {
    let file = match OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ.0)
        .custom_flags(NO_RECALL)
        .open(file)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(State {
                version: VERSION,
                rejections: Vec::new(),
            });
        }
        Err(_) => return Err(UNAVAILABLE),
    };
    validate_attributes(&file, false).map_err(|_| UNAVAILABLE)?;
    identity(&file).map_err(|_| UNAVAILABLE)?;
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > LIMIT {
        return Err(UNAVAILABLE);
    }
    let state: State = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    if state.version != VERSION
        || !state.rejections.windows(2).all(|pair| pair[0] < pair[1])
        || !state
            .rejections
            .iter()
            .all(|entry| normalized(entry).as_ref() == Some(entry))
    {
        return Err(UNAVAILABLE);
    }
    Ok(state)
}

fn commit(directory: &Path, file: &Path, state: &State) -> Outcome<()> {
    let bytes = serde_json::to_vec(state).map_err(|_| UNAVAILABLE)?;
    if bytes.len() as u64 > LIMIT {
        return Err((413, "Shared Drive rejection state is full."));
    }
    let temp = directory.join(".rejections.tmp");
    // A process interrupted before replacement can leave only this scratch file.
    // Remove it under the mutex without opening it or using its contents.
    match fs::remove_file(&temp) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(UNAVAILABLE),
    }
    let result = (|| {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(&temp)
            .map_err(|_| UNAVAILABLE)?;
        output.write_all(&bytes).map_err(|_| UNAVAILABLE)?;
        output.sync_all().map_err(|_| UNAVAILABLE)?;
        drop(output);
        let wide = |path: &Path| {
            r"\\?\"
                .encode_utf16()
                .chain(path.as_os_str().encode_wide())
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        let from = wide(&temp);
        let to = wide(file);
        unsafe {
            MoveFileExW(
                windows::core::PCWSTR(from.as_ptr()),
                windows::core::PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|_| UNAVAILABLE)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn open_directory(directory: &Path, create: bool) -> Outcome<Option<File>> {
    match lock_directory(directory) {
        Ok(lock) => Ok(Some(lock)),
        Err((404, _)) if !create => Ok(None),
        Err((404, _)) => {
            match fs::create_dir(directory) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(UNAVAILABLE),
            }
            lock_directory(directory).map(Some).map_err(|_| UNAVAILABLE)
        }
        Err(_) => Err(UNAVAILABLE),
    }
}

pub(super) fn perform(workspace: &Path, request: &Value) -> Outcome<Value> {
    let update = match request["action"].as_str() {
        Some("list-rejections") => None,
        Some("set-rejection") => Some((
            request["relativePath"]
                .as_str()
                .and_then(normalized)
                .ok_or(INVALID_INPUT)?,
            request["rejected"].as_bool().ok_or(INVALID_INPUT)?,
        )),
        _ => return Err(INVALID_INPUT),
    };
    require_local_drive(workspace)?;
    let _serialization = StoreLock::acquire()?;
    let project = workspace.join("projects").join("author-ashlyn-brooks");
    let (project, _ancestors) = lock_local_tree(&project).map_err(|_| UNAVAILABLE)?;
    let directory = project.join(DIRECTORY);
    let directory_lock = open_directory(
        &directory,
        update.as_ref().is_some_and(|(_, rejected)| *rejected),
    )?;
    let file = directory.join(FILENAME);
    let mut state = if directory_lock.is_some() {
        load(&file)?
    } else {
        State {
            version: VERSION,
            rejections: Vec::new(),
        }
    };
    let Some((relative, rejected)) = update else {
        return Ok(json!({ "rejections": state.rejections }));
    };
    match (state.rejections.binary_search(&relative), rejected) {
        (Ok(index), false) => {
            state.rejections.remove(index);
        }
        (Err(index), true) => state.rejections.insert(index, relative.clone()),
        _ => return Ok(json!({ "relativePath": relative, "rejected": rejected })),
    }
    commit(&directory, &file, &state)?;
    Ok(json!({ "relativePath": relative, "rejected": rejected }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::fs::symlink_dir,
        path::PathBuf,
        process::Command,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        workspace: PathBuf,
        project: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let workspace = std::env::temp_dir()
                .join(format!("alpha-rejections-{}-{nonce}", std::process::id()));
            let project = workspace.join("projects/author-ashlyn-brooks");
            fs::create_dir_all(&project).unwrap();
            Self { workspace, project }
        }

        fn set(&self, relative: &str, rejected: bool) -> Outcome<Value> {
            set(&self.workspace, relative, rejected)
        }

        fn list(&self) -> Outcome<Value> {
            list(&self.workspace)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.workspace);
        }
    }

    fn set(workspace: &Path, relative: &str, rejected: bool) -> Outcome<Value> {
        perform(
            workspace,
            &json!({
                "action": "set-rejection", "relativePath": relative, "rejected": rejected,
                "root": "Z:/unused", "destination": "Z:/unused"
            }),
        )
    }

    fn list(workspace: &Path) -> Outcome<Value> {
        perform(workspace, &json!({ "action": "list-rejections" }))
    }

    #[test]
    fn state_is_path_scoped_and_independent_of_originals() {
        let fixture = Fixture::new();
        assert_eq!(fixture.list().unwrap(), json!({ "rejections": [] }));
        fixture.set("absent.txt", false).unwrap();
        assert!(!fixture.project.join(DIRECTORY).exists());
        assert_eq!(
            fixture.set("Cover\\Draft.txt", true).unwrap(),
            json!({ "relativePath": "Cover/Draft.txt", "rejected": true })
        );
        fixture.set("Cover/Draft.txt", true).unwrap();
        fixture.set("Back/Draft.txt", true).unwrap();
        let other = fixture.project.join("synthetic-originals");
        fs::create_dir_all(other.join("Cover")).unwrap();
        let original = other.join("Cover/Draft.txt");
        fs::write(&original, "first").unwrap();
        fs::remove_file(&original).unwrap();
        assert_eq!(
            fixture.list().unwrap(),
            json!({ "rejections": ["Back/Draft.txt", "Cover/Draft.txt"] })
        );
        fs::write(&original, "replacement").unwrap();
        assert_eq!(fixture.list().unwrap()["rejections"][1], "Cover/Draft.txt");
        let renamed = other.join("Cover/New.txt");
        fs::rename(original, &renamed).unwrap();
        assert_eq!(fixture.list().unwrap()["rejections"][1], "Cover/Draft.txt");
        fixture.set("Cover/draft.txt", false).unwrap();
        assert_eq!(fixture.list().unwrap()["rejections"][1], "Cover/Draft.txt");
        fixture.set("Cover/Draft.txt", false).unwrap();
        assert_eq!(
            fixture.list().unwrap(),
            json!({ "rejections": ["Back/Draft.txt"] })
        );
        assert_eq!(fs::read_to_string(renamed).unwrap(), "replacement");
        assert_eq!(
            fs::read_dir(fixture.project.join(DIRECTORY))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn state_survives_a_new_native_process() {
        let fixture = Fixture::new();
        fixture.set("before.txt", true).unwrap();
        let module = module_path!().split_once("::").unwrap().1;
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg(format!("{module}::restart_fixture_child"))
            .env("ALPHA_REJECTION_RESTART_FIXTURE", &fixture.workspace)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(
            fixture.list().unwrap(),
            json!({ "rejections": ["after.txt", "before.txt"] })
        );
    }

    #[test]
    fn restart_fixture_child() {
        if let Some(workspace) = std::env::var_os("ALPHA_REJECTION_RESTART_FIXTURE") {
            let workspace = PathBuf::from(workspace);
            assert_eq!(
                list(&workspace).unwrap(),
                json!({ "rejections": ["before.txt"] })
            );
            set(&workspace, "after.txt", true).unwrap();
        }
    }

    #[test]
    fn concurrent_updates_and_reads_keep_the_whole_state() {
        let fixture = Fixture::new();
        let barrier = std::sync::Barrier::new(9);
        thread::scope(|scope| {
            for worker in 0..8 {
                let (fixture, barrier) = (&fixture, &barrier);
                scope.spawn(move || {
                    let relative = format!("folder-{worker}/fixture.txt");
                    barrier.wait();
                    fixture.set(&relative, true).unwrap();
                    let state = fixture.list().unwrap();
                    assert!(state["rejections"]
                        .as_array()
                        .unwrap()
                        .contains(&json!(relative)));
                });
            }
            barrier.wait();
            for _ in 0..8 {
                fixture.list().unwrap();
            }
        });
        assert_eq!(
            fixture.list().unwrap()["rejections"]
                .as_array()
                .unwrap()
                .len(),
            8
        );
    }

    #[test]
    fn invalid_inputs_and_invalid_private_state_fail_closed() {
        let fixture = Fixture::new();
        for relative in [
            "",
            "../file",
            "/file",
            "a//file",
            "a/./file",
            "C:/file",
            "a/PRN.txt",
            "a/file:stream",
            "a/file.",
            "a/file ",
            "a/\u{85}file",
        ] {
            assert_eq!(fixture.set(relative, true).unwrap_err().0, 400);
        }
        assert_eq!(
            perform(
                &fixture.workspace,
                &json!({
                    "action": "set-rejection", "relativePath": "file.txt", "rejected": "true"
                })
            )
            .unwrap_err()
            .0,
            400
        );
        fixture.set("before.txt", true).unwrap();
        let directory = fixture.project.join(DIRECTORY);
        let file = directory.join(FILENAME);
        // A leftover scratch write never replaces the last committed version.
        fs::write(directory.join(".rejections.tmp"), "{incomplete").unwrap();
        assert_eq!(
            fixture.list().unwrap(),
            json!({ "rejections": ["before.txt"] })
        );
        fixture.set("after.txt", true).unwrap();
        assert!(!directory.join(".rejections.tmp").exists());
        // An interrupted/denied replacement preserves the last complete file.
        fs::create_dir(directory.join(".rejections.tmp")).unwrap();
        assert_eq!(fixture.set("blocked.txt", true).unwrap_err(), UNAVAILABLE);
        assert_eq!(
            fixture.list().unwrap(),
            json!({ "rejections": ["after.txt", "before.txt"] })
        );
        for invalid in [
            r#"{"version":2,"rejections":[]}"#,
            r#"{"version":1,"rejections":["../outside"]}"#,
            r#"{"version":1,"rejections":["same","same"]}"#,
            r#"{"version":1,"rejections":[],"privateData":"unused"}"#,
            "{incomplete",
        ] {
            fs::write(&file, invalid).unwrap();
            assert_eq!(fixture.list().unwrap_err(), UNAVAILABLE);
            assert_eq!(fixture.set("file.txt", true).unwrap_err(), UNAVAILABLE);
            assert_eq!(fs::read_to_string(&file).unwrap(), invalid);
        }
    }

    #[test]
    fn redirected_or_shared_state_is_unavailable() {
        let fixture = Fixture::new();
        let outside = fixture.workspace.join("outside");
        fs::create_dir(&outside).unwrap();
        let directory = fixture.project.join(DIRECTORY);
        if symlink_dir(&outside, &directory).is_err() {
            let status = Command::new("cmd.exe")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&directory)
                .arg(&outside)
                .output()
                .unwrap();
            assert!(status.status.success());
        }
        assert_eq!(fixture.list().unwrap_err(), UNAVAILABLE);
        assert_eq!(fixture.set("file.txt", true).unwrap_err(), UNAVAILABLE);
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        fs::remove_dir(&directory).unwrap();
        fs::create_dir(&directory).unwrap();
        let target = outside.join("state.json");
        let state = r#"{"version":1,"rejections":[]}"#;
        fs::write(&target, state).unwrap();
        fs::hard_link(&target, directory.join(FILENAME)).unwrap();
        assert_eq!(fixture.list().unwrap_err(), UNAVAILABLE);
        assert_eq!(fixture.set("file.txt", true).unwrap_err(), UNAVAILABLE);
        assert_eq!(fs::read_to_string(&target).unwrap(), state);
    }
}
