use serde_json::{json, Value};
use std::path::Path;

pub(super) fn response(request: Value, workspace: &Path) -> Value {
    #[cfg(windows)]
    let result = windows::perform(&request, workspace);
    #[cfg(not(windows))]
    let result: Result<Value, (u16, &'static str)> = {
        let _ = workspace;
        Err((
            503,
            "Artifact imports require the Windows desktop file boundary.",
        ))
    };
    let request_id = &request["requestId"];
    match result {
        Ok(value) => {
            json!({"type":"worker-artifact-operation","requestId":request_id,"result":value})
        }
        Err(failure) => {
            let (status, error) = failure;
            let mut reply = json!({"type":"worker-artifact-operation","requestId":request_id,"status":status,"error":error});
            #[cfg(windows)]
            {
                if let Some(access) = crate::worker_files::windows::access_reason(
                    failure,
                    request["action"] == "scan",
                ) {
                    reply["access"] = json!(access);
                } else if status == 409 {
                    reply["reason"] = json!(windows::conflict_reason(error));
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
mod windows {
    use super::*;
    use crate::{
        shared_drive::windows_files::{
            component_allowed, file_identity, identity, lock_directory, lock_local_tree,
            open_original, revision, validate_attributes, Failure, Outcome, FILE_IN_USE, NO_RECALL,
            OS_ACCESS_DENIED,
        },
        worker_files::windows::{
            os_failure, protect_workspace, remove_stage, rename_new, workspace_root, write_new,
        },
    };
    use ::windows::Win32::Storage::FileSystem::{
        DELETE, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_SYSTEM, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
    };
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::{
        collections::{BTreeMap, BTreeSet},
        fs::{self, File, OpenOptions},
        io::{self, Read, Write},
        os::windows::fs::{MetadataExt, OpenOptionsExt},
        path::PathBuf,
    };

    const DENIED: Failure = (403, "The artifact is outside the approved local layout.");
    const STALE: Failure = (
        409,
        "The reviewed artifact or destination changed. Review again.",
    );
    const COLLISION: Failure = (409, "The destination artifact already exists.");
    const LIMIT: Failure = (413, "The artifact exceeds the supported import limits.");
    const UNSUPPORTED: Failure = (415, "The artifact has an unsupported companion or layout.");
    const FAILED: Failure = (503, "Windows could not complete the artifact operation.");
    const MAX_FILES: usize = 24;
    const MAX_BYTES: usize = 256 * 1024;
    const MAX_FILE_BYTES: usize = 128 * 1024;
    const MAX_DEPTH: usize = 5;

    pub(super) fn conflict_reason(error: &str) -> &'static str {
        if error == COLLISION.1 {
            "collision"
        } else {
            "changed"
        }
    }

    fn redact(error: Failure) -> Failure {
        if matches!(error, OS_ACCESS_DENIED | FILE_IN_USE) {
            return error;
        }
        match error.0 {
            403 => DENIED,
            404 => (
                404,
                "The exact artifact or project workspace is unavailable.",
            ),
            409 => STALE,
            _ => FAILED,
        }
    }

    fn io_error(error: io::Error) -> Failure {
        if let Some(failure) = os_failure(&error) {
            return failure;
        }
        match error.kind() {
            io::ErrorKind::AlreadyExists => COLLISION,
            io::ErrorKind::NotFound => (
                404,
                "The exact artifact or project workspace is unavailable.",
            ),
            _ => FAILED,
        }
    }

    fn slug(value: &Value) -> Outcome<&str> {
        let text = value.as_str().ok_or(DENIED)?;
        if text.is_empty()
            || text.len() > 64
            || text.starts_with('-')
            || text.ends_with('-')
            || !text
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
            || !component_allowed(text)
            || protected_name(text)
        {
            return Err(DENIED);
        }
        Ok(text)
    }

    fn protected_name(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or_default();
        matches!(
            stem,
            "agents" | "settings" | "mcp" | "hooks" | "permissions" | "grants"
        ) || [
            "credential",
            "password",
            "private-key",
            "private_key",
            "secret",
            "token",
            "api-key",
            "api_key",
            "oauth",
            "signing",
        ]
        .iter()
        .any(|part| stem.contains(part))
            || stem.split(['-', '_']).any(|part| part == "auth")
    }

    fn regular_component(name: &str) -> bool {
        !name.is_empty()
            && name.len() <= 80
            && name.as_bytes()[0].is_ascii_alphanumeric()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && component_allowed(name)
    }

    fn public_attributes(file: &File, directory: bool) -> Outcome<()> {
        validate_attributes(file, directory).map_err(redact)?;
        let flags = file.metadata().map_err(io_error)?.file_attributes();
        if flags & (FILE_ATTRIBUTE_HIDDEN.0 | FILE_ATTRIBUTE_SYSTEM.0) != 0 {
            return Err(DENIED);
        }
        Ok(())
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Kind {
        Skill,
        Knowledge,
        Agent,
    }

    impl Kind {
        fn parse(value: &Value) -> Outcome<Self> {
            match value.as_str() {
                Some("skill") => Ok(Self::Skill),
                Some("knowledge") => Ok(Self::Knowledge),
                Some("agent") => Ok(Self::Agent),
                _ => Err(DENIED),
            }
        }

        fn containers(self) -> &'static [&'static str] {
            match self {
                Self::Skill => &[".agents", "skills"],
                Self::Knowledge => &["knowledge"],
                Self::Agent => &[".claude", "agents"],
            }
        }

        fn entry(self, id: &str) -> String {
            match self {
                Self::Skill => id.to_owned(),
                Self::Knowledge | Self::Agent => format!("{id}.md"),
            }
        }
    }

    fn companion(path: &str, directory: bool) -> Outcome<()> {
        let parts = path.split('/').collect::<Vec<_>>();
        if parts.len() > MAX_DEPTH
            || path.len() > 300
            || !parts.iter().all(|part| regular_component(part))
        {
            return Err(DENIED);
        }
        if path == "agents" && directory || path == "agents/openai.yaml" && !directory {
            return Ok(());
        }
        if parts.iter().any(|part| protected_name(part)) {
            return Err(DENIED);
        }
        if directory {
            return if parts[0] == "references" {
                Ok(())
            } else {
                Err(UNSUPPORTED)
            };
        }
        let name = parts.last().ok_or(DENIED)?;
        let lower = name.to_ascii_lowercase();
        let notice = ["license", "notice", "copying"].iter().any(|stem| {
            lower == *stem || lower == format!("{stem}.txt") || lower == format!("{stem}.md")
        });
        if parts.len() == 1 && (path == "SKILL.md" || notice)
            || parts.len() > 1 && parts[0] == "references" && lower.ends_with(".md")
        {
            return Ok(());
        }
        Err(UNSUPPORTED)
    }

    #[derive(Serialize)]
    struct ArtifactFile {
        path: String,
        contents: String,
    }

    #[derive(Default)]
    struct SourceSnapshot {
        files: BTreeMap<String, ArtifactFile>,
        total: usize,
        // Keep each reviewed file name and contents pinned through publication.
        locks: Vec<File>,
        fingerprint: Sha256,
    }

    impl SourceSnapshot {
        fn bind(&mut self, relative: &str, id: &[u8; 12], contents: &[u8]) {
            self.fingerprint
                .update((relative.len() as u32).to_le_bytes());
            self.fingerprint.update(relative.as_bytes());
            self.fingerprint.update(id);
            self.fingerprint
                .update((contents.len() as u32).to_le_bytes());
            self.fingerprint.update(contents);
        }

        fn read(&mut self, root: &Path, path: &str) -> Outcome<()> {
            if self.files.len() >= MAX_FILES {
                return Err(LIMIT);
            }
            let (mut file, folders) =
                open_original(root.to_str().ok_or(DENIED)?, path, false).map_err(redact)?;
            public_attributes(&file, false)?;
            let id = identity(&file).map_err(redact)?;
            if file.metadata().map_err(io_error)?.len() > MAX_FILE_BYTES as u64 {
                return Err(LIMIT);
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            if bytes.len() > MAX_FILE_BYTES || self.total + bytes.len() > MAX_BYTES {
                return Err(LIMIT);
            }
            let text = String::from_utf8(bytes).map_err(|_| UNSUPPORTED)?;
            if text.contains('\0') {
                return Err(UNSUPPORTED);
            }
            self.bind(path, &id, text.as_bytes());
            self.total += text.len();
            let value = ArtifactFile {
                path: path.to_owned(),
                contents: text,
            };
            if self
                .files
                .insert(path.to_ascii_lowercase(), value)
                .is_some()
            {
                return Err(UNSUPPORTED);
            }
            self.locks.extend(folders);
            self.locks.push(file);
            Ok(())
        }

        fn scan_skill(
            &mut self,
            root: &Path,
            relative: &str,
            directories: &mut usize,
        ) -> Outcome<()> {
            *directories += 1;
            if *directories > MAX_FILES {
                return Err(LIMIT);
            }
            let directory = root.join(relative);
            let lock = lock_directory(&directory).map_err(redact)?;
            public_attributes(&lock, true)?;
            self.bind(
                &format!("{relative}/"),
                &file_identity(&lock, false).map_err(redact)?,
                &[],
            );
            self.locks.push(lock);
            let mut entries = Vec::new();
            for entry in fs::read_dir(directory).map_err(io_error)? {
                if entries.len() >= MAX_FILES * 2 {
                    return Err(LIMIT);
                }
                let entry = entry.map_err(io_error)?;
                let name = entry.file_name().into_string().map_err(|_| DENIED)?;
                let kind = entry.file_type().map_err(io_error)?;
                if kind.is_symlink() || !kind.is_dir() && !kind.is_file() {
                    return Err(DENIED);
                }
                let child = if relative.is_empty() {
                    name
                } else {
                    format!("{relative}/{name}")
                };
                companion(&child, kind.is_dir())?;
                entries.push((child, kind.is_dir()));
            }
            entries.sort_unstable();
            for (child, directory) in entries {
                if directory {
                    self.scan_skill(root, &child, directories)?;
                } else {
                    self.read(root, &child)?;
                }
            }
            Ok(())
        }

        fn revision(&self) -> String {
            format!("{:x}", self.fingerprint.clone().finalize())
        }
    }

    fn source(
        workspace: &Path,
        project: &Value,
        kind: Kind,
        entry: &str,
    ) -> Outcome<SourceSnapshot> {
        let root = workspace_root(workspace, project)?;
        let parent = root.join(kind.containers().join("/"));
        let (parent, locks) = lock_local_tree(&parent).map_err(redact)?;
        for lock in locks.iter().rev().take(kind.containers().len() + 1) {
            public_attributes(lock, true)?;
        }
        protect_workspace(&parent)?;
        let mut snapshot = SourceSnapshot {
            locks,
            ..Default::default()
        };
        if kind == Kind::Skill {
            snapshot.scan_skill(&parent.join(entry), "", &mut 0)?;
            if !snapshot
                .files
                .get("skill.md")
                .is_some_and(|file| file.path == "SKILL.md")
            {
                return Err(UNSUPPORTED);
            }
        } else {
            snapshot.read(&parent, entry)?;
        }
        Ok(snapshot)
    }

    struct Destination {
        final_path: PathBuf,
        suffix: Vec<String>,
        revision: String,
        catalog: Option<(Kind, Vec<u8>)>,
        _locks: Vec<File>,
    }

    fn simple_name(value: &str) -> Option<&str> {
        if value.starts_with('\'') {
            value.strip_prefix('\'')?.strip_suffix('\'')
        } else if value.starts_with('"') {
            value.strip_prefix('"')?.strip_suffix('"')
        } else {
            Some(value)
        }
    }

    fn registration_name(file: &mut File, expected: &str, kind: Kind) -> Outcome<()> {
        let mut bytes = Vec::new();
        (&mut *file)
            .take(8192)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| UNSUPPORTED)?;
        let mut lines = text.trim_start_matches('\u{feff}').lines();
        if lines.next() != Some("---") {
            return Err(UNSUPPORTED);
        }
        let mut fields = BTreeSet::new();
        let mut metadata = false;
        loop {
            let line = lines.next().ok_or(UNSUPPORTED)?;
            if line == "---" {
                break;
            }
            let (key, value) = line.split_once(':').ok_or(UNSUPPORTED)?;
            let value = value.trim();
            if !fields.insert(key) {
                return Err(UNSUPPORTED);
            }
            match key {
                "name" if simple_name(value) == Some(expected) => {}
                "description"
                    if !value.is_empty()
                        && !value.starts_with(['|', '>', '&', '*', '!', '{', '[']) => {}
                "license" if kind == Kind::Skill && !value.is_empty() => {}
                "metadata" if kind == Kind::Skill && value.is_empty() => metadata = true,
                "  short-description" if metadata && !value.is_empty() => {}
                _ => return Err(UNSUPPORTED),
            }
        }
        if !fields.contains("name") || !fields.contains("description") {
            return Err(UNSUPPORTED);
        }
        Ok(())
    }

    // Reject a registry with nested or ambiguous names that could shadow an
    // imported definition through a provider's frontmatter lookup.
    fn registration_catalog(parent: &Path, kind: Kind) -> Outcome<(Vec<File>, Vec<u8>)> {
        let mut names = BTreeSet::new();
        let mut locks = Vec::new();
        for entry in fs::read_dir(parent).map_err(io_error)? {
            if names.len() >= 64 {
                return Err(LIMIT);
            }
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name().into_string().map_err(|_| DENIED)?;
            let file_type = entry.file_type().map_err(io_error)?;
            let (id, relative) = match kind {
                Kind::Agent if file_type.is_file() => {
                    (name.strip_suffix(".md").ok_or(UNSUPPORTED)?, name.clone())
                }
                Kind::Skill if file_type.is_dir() => (&*name, format!("{name}/SKILL.md")),
                _ => return Err(UNSUPPORTED),
            };
            slug(&json!(id)).map_err(|_| UNSUPPORTED)?;
            let (mut file, folders) =
                open_original(parent.to_str().ok_or(DENIED)?, &relative, false).map_err(redact)?;
            public_attributes(&file, false)?;
            identity(&file).map_err(redact)?;
            if kind == Kind::Skill {
                public_attributes(folders.last().ok_or(DENIED)?, true)?;
            }
            registration_name(&mut file, id, kind)?;
            if !names.insert(name) {
                return Err(UNSUPPORTED);
            }
            locks.extend(folders);
            locks.push(file);
        }
        Ok((
            locks,
            names
                .into_iter()
                .collect::<Vec<_>>()
                .join("\n")
                .into_bytes(),
        ))
    }

    fn destination(
        workspace: &Path,
        project: &Value,
        kind: Kind,
        entry: &str,
    ) -> Outcome<Destination> {
        let root = workspace_root(workspace, project)?;
        let (mut parent, mut locks) = lock_local_tree(&root).map_err(redact)?;
        public_attributes(locks.last().ok_or(DENIED)?, true)?;
        protect_workspace(&parent)?;
        let mut remaining = kind
            .containers()
            .iter()
            .copied()
            .map(|part| (part, false))
            .chain([(entry, true)]);
        let mut missing = None;
        for (component, is_entry) in remaining.by_ref() {
            let path = parent.join(component);
            match fs::symlink_metadata(&path) {
                Ok(_) if is_entry => return Err(COLLISION),
                Ok(_) => {
                    let file = lock_directory(&path).map_err(redact)?;
                    public_attributes(&file, true)?;
                    protect_workspace(&path)?;
                    locks.push(file);
                    parent = path;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    missing = Some(component);
                    break;
                }
                Err(error) => return Err(io_error(error)),
            }
        }
        let first = missing.ok_or(COLLISION)?;
        let suffix: Vec<String> = remaining.map(|(part, _)| part.to_owned()).collect();
        let id = file_identity(locks.last().ok_or(DENIED)?, false).map_err(redact)?;
        let mut binding = format!("{first}/{}\n", suffix.join("/"))
            .to_ascii_lowercase()
            .into_bytes();
        let catalog = if kind != Kind::Knowledge && suffix.is_empty() {
            let (catalog_locks, catalog) = registration_catalog(&parent, kind)?;
            binding.extend(&catalog);
            locks.extend(catalog_locks);
            Some((kind, catalog))
        } else {
            None
        };
        let destination_revision = revision(&id, &binding);
        let final_path = parent.join(first);
        Ok(Destination {
            final_path,
            suffix,
            revision: destination_revision,
            catalog,
            _locks: locks,
        })
    }

    impl Destination {
        fn verify_catalog(&self) -> Outcome<Vec<File>> {
            let Some((kind, expected)) = &self.catalog else {
                return Ok(Vec::new());
            };
            let parent = self.final_path.parent().ok_or(DENIED)?;
            let (locks, observed) = registration_catalog(parent, *kind)?;
            if &observed != expected {
                return Err(STALE);
            }
            Ok(locks)
        }
    }

    fn approved_files<'a>(
        request: &'a Value,
        source: &SourceSnapshot,
    ) -> Outcome<BTreeMap<&'a str, &'a [u8]>> {
        let list = request["files"].as_array().ok_or(DENIED)?;
        if list.len() != source.files.len() {
            return Err(STALE);
        }
        let mut result = BTreeMap::new();
        let mut total = 0;
        for item in list {
            let object = item.as_object().ok_or(DENIED)?;
            let path = item["path"].as_str().ok_or(DENIED)?;
            let contents = item["contents"].as_str().ok_or(DENIED)?;
            if object.len() != 2
                || contents.contains('\0')
                || !source
                    .files
                    .get(&path.to_ascii_lowercase())
                    .is_some_and(|file| file.path == path)
                || result.insert(path, contents.as_bytes()).is_some()
            {
                return Err(DENIED);
            }
            total += contents.len();
            if contents.len() > MAX_FILE_BYTES || total > MAX_BYTES {
                return Err(LIMIT);
            }
        }
        Ok(result)
    }

    fn stage_file(path: &Path, contents: &[u8]) -> Outcome<File> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .access_mode(FILE_GENERIC_WRITE.0 | DELETE.0)
            .share_mode(0)
            .custom_flags(NO_RECALL)
            .open(path)
            .map_err(io_error)?;
        public_attributes(&file, false)?;
        identity(&file).map_err(redact)?;
        file.write_all(contents)
            .and_then(|_| file.sync_all())
            .map_err(io_error)?;
        Ok(file)
    }

    fn stage_folder(path: &Path) -> Outcome<File> {
        let file = OpenOptions::new()
            .access_mode(DELETE.0 | FILE_READ_ATTRIBUTES.0)
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(NO_RECALL | FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
            .map_err(io_error)?;
        public_attributes(&file, true)?;
        Ok(file)
    }

    fn create_staged_directory(
        stage: &Path,
        destination: &Destination,
        files: BTreeMap<PathBuf, &[u8]>,
    ) -> Outcome<()> {
        fs::create_dir(stage).map_err(io_error)?;
        let stage_lock = stage_folder(stage)?;
        let mut folders = BTreeMap::new();
        let mut written = BTreeMap::new();
        let perform = (|| {
            for (relative, contents) in files {
                let mut directory = stage.to_path_buf();
                for segment in relative.parent().ok_or(DENIED)?.components() {
                    directory.push(segment);
                    if folders.contains_key(&directory) {
                        continue;
                    }
                    fs::create_dir(&directory).map_err(io_error)?;
                    let lock = stage_folder(&directory)?;
                    folders.insert(directory.clone(), lock);
                }
                let target = stage.join(relative);
                let staged_file = stage_file(&target, contents)?;
                written.insert(target, staged_file);
            }
            // An unexpected entry prevents publication. Never traverse or
            // remove an entry outside the known staged set on failure.
            for directory in std::iter::once(stage).chain(folders.keys().map(PathBuf::as_path)) {
                for entry in fs::read_dir(directory).map_err(io_error)? {
                    let entry = entry.map_err(io_error)?.path();
                    if !folders.contains_key(&entry) && !written.contains_key(&entry) {
                        return Err(DENIED);
                    }
                }
            }
            let _catalog_locks = destination.verify_catalog()?;
            // Windows rejects renaming directories with open descendants.
            // Their handles close only at the commit point in private state.
            written.clear();
            folders.clear();
            rename_new(&stage_lock, &destination.final_path).map_err(redact)
        })();
        if perform.is_err() {
            for (_, file) in written {
                remove_stage(&file);
            }
            for (_, folder) in folders.into_iter().rev() {
                remove_stage(&folder);
            }
            // Unknown entries stay outside provider discovery.
            remove_stage(&stage_lock);
        }
        perform
    }

    fn publish(
        workspace: &Path,
        request: &Value,
        destination: Destination,
        kind: Kind,
        contents: BTreeMap<&str, &[u8]>,
    ) -> Outcome<()> {
        let request_id = request["requestId"]
            .as_str()
            .filter(|id| {
                id.len() == 36
                    && id
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            })
            .ok_or(DENIED)?;
        // The staging name lives outside provider discovery even when the
        // final artifact container already exists.
        let (stage_root, _stage_locks) =
            lock_local_tree(&workspace.join(".alpha")).map_err(redact)?;
        let stage = stage_root.join(format!(".alpha-import-{request_id}.tmp"));
        if kind != Kind::Skill && destination.suffix.is_empty() {
            let bytes = contents.values().next().ok_or(DENIED)?;
            let _catalog_locks = destination.verify_catalog()?;
            return write_new(&stage, &destination.final_path, bytes).map_err(redact);
        }
        let base: PathBuf = destination.suffix.iter().collect();
        let output = contents
            .into_iter()
            .map(|(relative, bytes)| {
                let to = if kind == Kind::Skill {
                    base.join(relative)
                } else {
                    base.clone()
                };
                (to, bytes)
            })
            .collect();
        create_staged_directory(&stage, &destination, output)
    }

    pub(super) fn perform(request: &Value, workspace: &Path) -> Outcome<Value> {
        let action = request["action"].as_str().ok_or(DENIED)?;
        if !matches!(action, "scan" | "apply")
            || request["sourceProjectId"] == request["destinationProjectId"]
        {
            return Err(DENIED);
        }
        let kind = Kind::parse(&request["kind"])?;
        let entry = kind.entry(slug(&request["artifactId"])?);
        let source = source(workspace, &request["sourceProjectId"], kind, &entry)?;
        let destination = destination(workspace, &request["destinationProjectId"], kind, &entry)?;
        let source_revision = source.revision();
        if action == "scan" {
            return Ok(json!({
                "sourceRevision": source_revision,
                "destinationRevision": destination.revision,
                "files": source.files.values().collect::<Vec<_>>()
            }));
        }
        if request["sourceRevision"].as_str() != Some(source_revision.as_str())
            || request["destinationRevision"].as_str() != Some(destination.revision.as_str())
        {
            return Err(STALE);
        }
        let files = approved_files(request, &source)?;
        publish(workspace, request, destination, kind, files)?;
        Ok(json!({ "applied": true }))
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
                let suffix = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let instance = Self(
                    std::env::temp_dir()
                        .join(format!("alpha-artifact-{}-{suffix}", std::process::id())),
                );
                fs::create_dir_all(instance.0.join(".alpha")).unwrap();
                for name in ["source-project", "destination-project"] {
                    fs::create_dir_all(instance.project(name)).unwrap();
                }
                instance
            }

            fn project(&self, name: &str) -> PathBuf {
                self.0.join("projects").join(name).join("workspace")
            }

            fn write(&self, project: &str, relative: &str, contents: &str) -> PathBuf {
                let path = self.project(project).join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, contents).unwrap();
                path
            }

            fn request(&self, kind: &str, name: &str) -> Value {
                json!({"action":"scan","kind":kind,"artifactId":name,"sourceProjectId":"source-project",
                        "destinationProjectId":"destination-project","requestId":"01234567-0123-4567-89ab-0123456789ab"})
            }

            fn apply(&self, request: &Value, scan: &Value) -> Value {
                let mut wire = request.clone();
                wire["action"] = json!("apply");
                for field in ["files", "sourceRevision", "destinationRevision"] {
                    wire[field] = scan[field].clone();
                }
                wire
            }
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }

        #[test]
        fn publishes_all_three_layouts_and_creates_missing_containers_as_a_unit() {
            let fixture = Fixture::new();
            let values = [
                (
                    "skill",
                    "review-notes",
                    ".agents/skills/review-notes/SKILL.md",
                    "---\nname: review-notes\ndescription: Example\n---\nRead these notes.\n",
                ),
                (
                    "knowledge",
                    "weekly-notes",
                    "knowledge/weekly-notes.md",
                    "# Weekly notes\n",
                ),
                (
                    "agent",
                    "report-reader",
                    ".claude/agents/report-reader.md",
                    "---\nname: report-reader\ndescription: Example\n---\nReview the report.\n",
                ),
            ];
            for (kind, name, relative, contents) in values {
                let original = fixture.write("source-project", relative, contents);
                if kind == "skill" {
                    fixture.write(
                        "source-project",
                        ".agents/skills/review-notes/references/detail.md",
                        "# Details\n",
                    );
                    fixture.write(
                        "source-project",
                        ".agents/skills/review-notes/LICENSE",
                        "License notice\n",
                    );
                }
                let request = fixture.request(kind, name);
                let scan = perform(&request, &fixture.0).unwrap();
                let mut apply = fixture.apply(&request, &scan);
                let primary = apply["files"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|entry| {
                        entry["path"].as_str().unwrap()
                            == Path::new(relative).file_name().unwrap().to_str().unwrap()
                    })
                    .unwrap();
                primary["contents"] = json!(format!("{contents}\n"));
                assert_eq!(perform(&apply, &fixture.0).unwrap()["applied"], true);
                assert_eq!(fs::read_to_string(original).unwrap(), contents);
                assert_eq!(
                    fs::read_to_string(fixture.project("destination-project").join(relative))
                        .unwrap(),
                    format!("{contents}\n")
                );
                assert_eq!(perform(&apply, &fixture.0), Err(COLLISION));
            }
            let destination = fixture
                .project("destination-project")
                .join(".agents/skills/review-notes");
            assert_eq!(
                fs::read_to_string(destination.join("references/detail.md")).unwrap(),
                "# Details\n"
            );
            assert_eq!(
                fs::read_to_string(destination.join("LICENSE")).unwrap(),
                "License notice\n"
            );
        }

        #[test]
        fn rejects_changed_source_destination_collision_and_alias_registrations() {
            let fixture = Fixture::new();
            let file = fixture.write(
                "source-project",
                "knowledge/weekly-notes.md",
                "# Weekly notes\n",
            );
            let request = fixture.request("knowledge", "weekly-notes");
            let scan = perform(&request, &fixture.0).unwrap();
            let apply = fixture.apply(&request, &scan);
            fs::write(&file, "# Changed\n").unwrap();
            assert_eq!(perform(&apply, &fixture.0), Err(STALE));
            assert!(!fixture
                .project("destination-project")
                .join("knowledge")
                .exists());
            fs::write(&file, "# Weekly notes\n").unwrap();
            fixture.write(
                "destination-project",
                "knowledge/other.md",
                "# Different notes\n",
            );
            assert_eq!(perform(&apply, &fixture.0), Err(STALE));
            let scan = perform(&request, &fixture.0).unwrap();
            assert_eq!(
                perform(&fixture.apply(&request, &scan), &fixture.0).unwrap()["applied"],
                true
            );
            fixture.write(
                "source-project",
                ".claude/agents/report-reader.md",
                "---\nname: report-reader\ndescription: Example\n---\n",
            );
            fixture.write(
                "destination-project",
                ".claude/agents/different.md",
                "---\nname: report-reader\ndescription: Alias\n---\n",
            );
            assert_eq!(
                perform(&fixture.request("agent", "report-reader"), &fixture.0),
                Err(UNSUPPORTED)
            );
            fixture.write(
                "destination-project",
                ".claude/agents/different.md",
                "---\nname: 'different'\ndescription: Existing agent\n---\n",
            );
            let request = fixture.request("agent", "report-reader");
            let scan = perform(&request, &fixture.0).unwrap();
            assert_eq!(
                perform(&fixture.apply(&request, &scan), &fixture.0).unwrap()["applied"],
                true
            );

            fixture.write(
                "source-project",
                ".agents/skills/report-reader/SKILL.md",
                "---\nname: report-reader\ndescription: Skill\n---\n",
            );
            fixture.write(
                "destination-project",
                ".agents/skills/alternate/SKILL.md",
                "---\nname: report-reader\ndescription: Existing alias\n---\n",
            );
            assert_eq!(
                perform(&fixture.request("skill", "report-reader"), &fixture.0),
                Err(UNSUPPORTED)
            );
        }

        #[test]
        fn refuses_paths_credentials_repositories_hardlinks_and_symlinks() {
            let fixture = Fixture::new();
            let mut invalid = fixture.request("knowledge", "../passwd");
            assert_eq!(perform(&invalid, &fixture.0), Err(DENIED));
            invalid["artifactId"] = json!("api-secrets");
            assert_eq!(perform(&invalid, &fixture.0), Err(DENIED));
            invalid["artifactId"] = json!("notes");
            invalid["sourceProjectId"] = json!("mooseville");
            assert_eq!(perform(&invalid, &fixture.0).unwrap_err().0, 403);
            let source = fixture.write("source-project", "knowledge/notes.md", "# Notes");
            let request = fixture.request("knowledge", "notes");
            let hardlink = fixture.0.join("hardlink.md");
            fs::hard_link(&source, &hardlink).unwrap();
            assert_eq!(perform(&request, &fixture.0), Err(DENIED));
            fs::remove_file(hardlink).unwrap();
            let outside = fixture.0.join("outside.md");
            fs::write(&outside, "# Outside").unwrap();
            fs::remove_file(&source).unwrap();
            if symlink_file(outside, &source).is_ok() {
                assert_eq!(perform(&request, &fixture.0), Err(DENIED));
                fs::remove_file(&source).unwrap();
            }
            fs::write(&source, "# Notes").unwrap();
            fs::create_dir(fixture.project("source-project").join(".git")).unwrap();
            assert_eq!(perform(&request, &fixture.0).unwrap_err().0, 403);
        }
    }
}
