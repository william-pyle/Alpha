use serde::Serialize;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageResult {
    pub allocated_bytes: u64,
    pub logical_bytes: u64,
    pub files: u64,
    pub skipped_links: u64,
    pub errors: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn available() -> bool {
    cfg!(windows)
}

pub fn response(request_id: Value, path: Option<&str>) -> Value {
    let mut result = match path {
        Some(path) => scan(Path::new(path)),
        None => StorageResult::failed("The project storage path must be a string"),
    };
    if result.errors > 0 && result.error.is_none() {
        result.error = Some(format!(
            "{} path{} could not be measured; results are incomplete",
            result.errors,
            if result.errors == 1 { "" } else { "s" }
        ));
    }
    let mut value = serde_json::to_value(result).unwrap_or_else(|error| {
        serde_json::json!({
            "allocatedBytes": 0,
            "logicalBytes": 0,
            "files": 0,
            "skippedLinks": 0,
            "errors": 1,
            "error": error.to_string(),
        })
    });
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "type".to_owned(),
            Value::String("project-storage-result".to_owned()),
        );
        object.insert("requestId".to_owned(), request_id);
    }
    value
}

impl StorageResult {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            errors: 1,
            error: Some(message.into()),
            ..Self::default()
        }
    }
}

#[cfg(not(windows))]
pub fn scan(_root: &Path) -> StorageResult {
    StorageResult::failed("Native Windows disk measurement unavailable")
}

#[cfg(windows)]
mod platform {
    use super::StorageResult;
    use std::{
        collections::HashSet,
        fs,
        mem::{size_of, MaybeUninit},
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
    };
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            Storage::FileSystem::{
                CreateFileW, FileAttributeTagInfo, FileCompressionInfo, FileIdInfo,
                FileStandardInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_REPARSE_POINT,
                FILE_ATTRIBUTE_TAG_INFO, FILE_COMPRESSION_INFO, FILE_FLAGS_AND_ATTRIBUTES,
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO,
                FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_MODE, FILE_SHARE_READ,
                FILE_SHARE_WRITE, FILE_STANDARD_INFO, OPEN_EXISTING,
            },
        },
    };

    #[derive(Debug, Eq, Hash, PartialEq)]
    struct FileIdentity {
        volume: u64,
        id: [u8; 16],
    }

    struct FileHandle(HANDLE);

    impl Drop for FileHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn open_without_following(path: &Path, share_delete: bool) -> Result<FileHandle, String> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut share = FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0;
        if share_delete {
            share |= FILE_SHARE_DELETE.0;
        }
        let share = FILE_SHARE_MODE(share);
        let flags = FILE_FLAGS_AND_ATTRIBUTES(
            FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0,
        );
        let handle = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                FILE_READ_ATTRIBUTES.0,
                share,
                None,
                OPEN_EXISTING,
                flags,
                None,
            )
        }
        .map_err(|error| format!("{}: {error}", path.display()))?;
        Ok(FileHandle(handle))
    }

    fn information<T: Default>(
        handle: HANDLE,
        class: windows::Win32::Storage::FileSystem::FILE_INFO_BY_HANDLE_CLASS,
    ) -> windows::core::Result<T> {
        let mut value = MaybeUninit::<T>::zeroed();
        unsafe {
            GetFileInformationByHandleEx(
                handle,
                class,
                value.as_mut_ptr().cast(),
                size_of::<T>() as u32,
            )?;
            Ok(value.assume_init())
        }
    }

    fn is_reparse(handle: HANDLE) -> Result<bool, String> {
        let info: FILE_ATTRIBUTE_TAG_INFO =
            information(handle, FileAttributeTagInfo).map_err(|error| error.to_string())?;
        Ok(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0)
    }

    fn reject_reparse_ancestors(path: &Path) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;
        for ancestor in path.ancestors() {
            let metadata = fs::symlink_metadata(ancestor)
                .map_err(|error| format!("{}: {error}", ancestor.display()))?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
                return Err(format!(
                    "Project storage roots cannot be inside or be a reparse point: {}",
                    ancestor.display()
                ));
            }
        }
        Ok(())
    }

    fn validated_root(root: &Path) -> Result<PathBuf, String> {
        if !root.is_absolute() {
            return Err("The project storage path must be absolute".to_owned());
        }
        reject_reparse_ancestors(root)?;
        let root = root
            .canonicalize()
            .map_err(|error| format!("{}: {error}", root.display()))?;
        reject_reparse_ancestors(&root)?;
        let handle = open_without_following(&root, true)?;
        if is_reparse(handle.0)? {
            return Err("The project storage root cannot be a reparse point".to_owned());
        }
        let standard: FILE_STANDARD_INFO = information(handle.0, FileStandardInfo)
            .map_err(|error| format!("{}: {error}", root.display()))?;
        if !standard.Directory {
            return Err("The project storage path must be a directory".to_owned());
        }
        Ok(root)
    }

    fn add_metric(target: &mut u64, value: u64, errors: &mut u64) {
        match target.checked_add(value) {
            Some(total) => *target = total,
            None => *errors = errors.saturating_add(1),
        }
    }

    pub fn scan(root: &Path) -> StorageResult {
        let root = match validated_root(root) {
            Ok(root) => root,
            Err(error) => return StorageResult::failed(error),
        };
        let mut result = StorageResult::default();
        let mut pending = vec![root];
        let mut physical_files = HashSet::<FileIdentity>::new();

        while let Some(directory) = pending.pop() {
            // Re-open every queued directory without following a reparse point and
            // without delete sharing. Holding this handle through enumeration
            // prevents the checked directory from being replaced by a junction.
            let directory_handle = match open_without_following(&directory, false) {
                Ok(handle) => handle,
                Err(_) => {
                    result.errors = result.errors.saturating_add(1);
                    continue;
                }
            };
            match is_reparse(directory_handle.0) {
                Ok(true) => {
                    result.skipped_links = result.skipped_links.saturating_add(1);
                    continue;
                }
                Ok(false) => {}
                Err(_) => {
                    result.errors = result.errors.saturating_add(1);
                    continue;
                }
            }
            match information::<FILE_STANDARD_INFO>(directory_handle.0, FileStandardInfo) {
                Ok(info) if info.Directory => {}
                _ => {
                    result.errors = result.errors.saturating_add(1);
                    continue;
                }
            }
            let entries = match fs::read_dir(&directory) {
                Ok(entries) => entries,
                Err(_) => {
                    result.errors = result.errors.saturating_add(1);
                    continue;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        result.errors = result.errors.saturating_add(1);
                        continue;
                    }
                };
                let path = entry.path();
                let handle = match open_without_following(&path, true) {
                    Ok(handle) => handle,
                    Err(_) => {
                        result.errors = result.errors.saturating_add(1);
                        continue;
                    }
                };
                match is_reparse(handle.0) {
                    Ok(true) => {
                        result.skipped_links = result.skipped_links.saturating_add(1);
                        continue;
                    }
                    Ok(false) => {}
                    Err(_) => {
                        result.errors = result.errors.saturating_add(1);
                        continue;
                    }
                }
                let standard: FILE_STANDARD_INFO = match information(handle.0, FileStandardInfo) {
                    Ok(info) => info,
                    Err(_) => {
                        result.errors = result.errors.saturating_add(1);
                        continue;
                    }
                };
                if standard.Directory {
                    pending.push(path);
                    continue;
                }

                result.files = result.files.saturating_add(1);
                if standard.EndOfFile < 0 {
                    result.errors = result.errors.saturating_add(1);
                    continue;
                }
                add_metric(
                    &mut result.logical_bytes,
                    standard.EndOfFile as u64,
                    &mut result.errors,
                );
                let identity: FILE_ID_INFO = match information(handle.0, FileIdInfo) {
                    Ok(info) => info,
                    Err(_) => {
                        result.errors = result.errors.saturating_add(1);
                        continue;
                    }
                };
                if physical_files.insert(FileIdentity {
                    volume: identity.VolumeSerialNumber,
                    id: identity.FileId.Identifier,
                }) {
                    let compression: FILE_COMPRESSION_INFO =
                        match information::<FILE_COMPRESSION_INFO>(handle.0, FileCompressionInfo) {
                            Ok(info) if info.CompressedFileSize >= 0 => info,
                            _ => {
                                result.errors = result.errors.saturating_add(1);
                                continue;
                            }
                        };
                    add_metric(
                        &mut result.allocated_bytes,
                        compression.CompressedFileSize as u64,
                        &mut result.errors,
                    );
                }
            }
        }
        result
    }
}

#[cfg(windows)]
pub use platform::scan;

#[cfg(all(test, windows))]
mod tests {
    use super::{response, scan};
    use serde_json::Value;
    use std::{
        fs::{self, File},
        io::Write,
        os::windows::ffi::OsStrExt,
        path::{Path, PathBuf},
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "alpha-project-storage-{label}-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir(&root).unwrap();
            Self { root }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn windows_allocated_bytes(path: &Path) -> u64 {
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::{GetLastError, SetLastError, WIN32_ERROR},
                Storage::FileSystem::GetCompressedFileSizeW,
            },
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut high = 0u32;
        unsafe {
            SetLastError(WIN32_ERROR(0));
            let low = GetCompressedFileSizeW(PCWSTR(wide.as_ptr()), Some(&mut high));
            let error = GetLastError();
            assert!(
                low != u32::MAX || error.0 == 0,
                "GetCompressedFileSizeW failed for {}: {error:?}",
                path.display()
            );
            ((high as u64) << 32) | low as u64
        }
    }

    #[test]
    fn malformed_request_returns_a_correlated_error_response() {
        let result = response(Value::String("request-7".to_owned()), None);
        assert_eq!(result["type"], "project-storage-result");
        assert_eq!(result["requestId"], "request-7");
        assert_eq!(result["allocatedBytes"], 0);
        assert_eq!(result["logicalBytes"], 0);
        assert_eq!(result["files"], 0);
        assert_eq!(result["skippedLinks"], 0);
        assert_eq!(result["errors"], 1);
        assert!(result["error"].as_str().unwrap().contains("path"));
    }

    #[test]
    fn measures_a_small_fixture_and_deduplicates_hardlink_allocation() {
        let fixture = Fixture::new("hardlink");
        let original = fixture.root.join("original.bin");
        fs::write(&original, b"alpha storage").unwrap();
        let one_name = scan(&fixture.root);
        fs::hard_link(&original, fixture.root.join("second-name.bin")).unwrap();
        fs::create_dir(fixture.root.join("empty-directory")).unwrap();

        let result = scan(&fixture.root);

        assert_eq!(result.errors, 0, "{result:?}");
        assert_eq!(result.files, 2);
        assert_eq!(result.logical_bytes, 26);
        assert_eq!(result.allocated_bytes, one_name.allocated_bytes);
        assert!(result.allocated_bytes > 0);
    }

    #[test]
    fn skips_a_directory_junction_when_windows_allows_fixture_creation() {
        let fixture = Fixture::new("junction");
        let target = Fixture::new("junction-target");
        fs::write(target.root.join("must-not-be-counted.txt"), b"outside").unwrap();
        let link = fixture.root.join("outside-link");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target.root)
            .status();
        if !status.is_ok_and(|status| status.success()) {
            eprintln!("skipped junction assertion: junction creation is unavailable");
            return;
        }

        let result = scan(&fixture.root);
        assert_eq!(result.errors, 0, "{result:?}");
        assert_eq!(result.files, 0);
        assert_eq!(result.logical_bytes, 0);
        assert_eq!(result.allocated_bytes, 0);
        assert_eq!(result.skipped_links, 1);

        fs::remove_dir(&link).unwrap();
    }

    #[test]
    fn reports_sparse_allocation_when_the_volume_supports_sparse_files() {
        let fixture = Fixture::new("sparse");
        let path = fixture.root.join("sparse.bin");
        File::create(&path).unwrap();
        let status = Command::new("fsutil")
            .args(["sparse", "setflag"])
            .arg(&path)
            .status();
        if !status.is_ok_and(|status| status.success()) {
            eprintln!("skipped sparse assertion: sparse files are unavailable");
            return;
        }
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(8 * 1024 * 1024)
            .unwrap();

        let result = scan(&fixture.root);
        assert_eq!(result.errors, 0, "{result:?}");
        assert_eq!(result.files, 1);
        assert_eq!(result.logical_bytes, 8 * 1024 * 1024);
        assert_eq!(result.allocated_bytes, windows_allocated_bytes(&path));
        assert!(result.allocated_bytes < result.logical_bytes, "{result:?}");
    }

    #[test]
    fn reports_compressed_allocation_when_the_volume_supports_compression() {
        let fixture = Fixture::new("compressed");
        let path = fixture.root.join("compressed.bin");
        let mut file = File::create(&path).unwrap();
        for _ in 0..8192 {
            file.write_all(&[b'A'; 1024]).unwrap();
        }
        drop(file);
        let status = Command::new("compact")
            .args(["/C", "/I", "/Q"])
            .arg(&path)
            .status();
        if !status.is_ok_and(|status| status.success()) {
            eprintln!("skipped compression assertion: filesystem compression is unavailable");
            return;
        }

        let result = scan(&fixture.root);
        assert_eq!(result.errors, 0, "{result:?}");
        assert_eq!(result.files, 1);
        assert_eq!(result.logical_bytes, 8 * 1024 * 1024);
        assert_eq!(result.allocated_bytes, windows_allocated_bytes(&path));
        if result.allocated_bytes >= result.logical_bytes {
            eprintln!("skipped compression ratio assertion: the file was not compressed");
            return;
        }
        assert!(result.allocated_bytes > 0, "{result:?}");
    }

    #[test]
    fn rejects_relative_and_reparse_roots() {
        let relative = scan(Path::new("relative-project"));
        assert_eq!(relative.errors, 1);
        assert!(relative.error.unwrap().contains("absolute"));

        let fixture = Fixture::new("root-link");
        let target = Fixture::new("root-target");
        let link = fixture.root.join("linked-root");
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target.root)
            .status();
        if !status.is_ok_and(|status| status.success()) {
            eprintln!("skipped reparse-root assertion: junction creation is unavailable");
            return;
        }
        let result = scan(&link);
        assert_eq!(result.errors, 1);
        assert!(result.error.unwrap().contains("reparse point"));
        fs::remove_dir(&link).unwrap();
    }
}
