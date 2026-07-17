use serde::Serialize;
use serde::de::DeserializeOwned;
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, FileTimes};
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const FILE_EXTENSION: &str = "json";
const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const FORMAT_VERSION_MARKER: &str = ".format-version";

#[derive(Debug, thiserror::Error)]
pub enum DesignStoreError {
    #[error("invalid design id")]
    InvalidDesignId,
    #[error("design store I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("design store serialization failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("stored design requires {entry_bytes} bytes but the disk budget is {budget_bytes}")]
    EntryTooLarge { entry_bytes: u64, budget_bytes: u64 },
}

#[derive(Debug, Clone, Copy)]
struct EntryMetadata {
    bytes: u64,
    last_accessed: SystemTime,
}

#[derive(Debug)]
pub struct DesignStore {
    directory: PathBuf,
    entries: HashMap<String, EntryMetadata>,
    order: BTreeSet<(SystemTime, String)>,
    total_bytes: u64,
    budget_bytes: u64,
    ttl: Duration,
}

impl DesignStore {
    pub fn open(
        directory: impl Into<PathBuf>,
        budget_bytes: u64,
        ttl: Duration,
    ) -> Result<Self, DesignStoreError> {
        let directory = directory.into();
        fs::create_dir_all(&directory)?;
        set_private_directory_permissions(&directory)?;

        let mut store = Self {
            directory,
            entries: HashMap::new(),
            order: BTreeSet::new(),
            total_bytes: 0,
            budget_bytes,
            ttl,
        };
        store.scan()?;
        store.prune(SystemTime::now())?;
        Ok(store)
    }

    pub fn open_versioned(
        directory: impl Into<PathBuf>,
        budget_bytes: u64,
        ttl: Duration,
        format_version: u32,
    ) -> Result<Self, DesignStoreError> {
        let directory = directory.into();
        fs::create_dir_all(&directory)?;
        set_private_directory_permissions(&directory)?;
        ensure_format_version(&directory, format_version)?;
        Self::open(directory, budget_bytes, ttl)
    }

    pub fn read<T: DeserializeOwned>(
        &mut self,
        design_id: &str,
    ) -> Result<Option<T>, DesignStoreError> {
        if !valid_design_id(design_id) {
            return Ok(None);
        }
        let now = SystemTime::now();
        self.prune(now)?;
        if !self.entries.contains_key(design_id) {
            return Ok(None);
        }

        let path = self.path_for(design_id);
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                self.forget(design_id);
                return Ok(None);
            }
            Err(err) => return Err(err.into()),
        };
        let value = serde_json::from_reader(BufReader::new(file))?;
        let touch_result = File::options()
            .write(true)
            .open(&path)
            .and_then(|file| file.set_times(FileTimes::new().set_accessed(now).set_modified(now)));
        if let Err(err) = touch_result {
            tracing::warn!(design_id, error = %err, "stored_design_touch_failed");
        }
        if let Some(entry) = self.entries.get_mut(design_id) {
            self.order
                .remove(&(entry.last_accessed, design_id.to_owned()));
            entry.last_accessed = now;
            self.order.insert((now, design_id.to_owned()));
        }
        Ok(Some(value))
    }

    pub fn write<T: Serialize>(
        &mut self,
        design_id: &str,
        value: &T,
    ) -> Result<u64, DesignStoreError> {
        if !valid_design_id(design_id) {
            return Err(DesignStoreError::InvalidDesignId);
        }
        let now = SystemTime::now();
        self.prune(now)?;

        let mut temporary = tempfile::NamedTempFile::new_in(&self.directory)?;
        {
            let mut writer = BufWriter::new(temporary.as_file_mut());
            serde_json::to_writer(&mut writer, value)?;
            writer.flush()?;
        }
        temporary.as_file().sync_all()?;
        let entry_bytes = temporary.as_file().metadata()?.len();
        let entry_limit = self.budget_bytes.min(MAX_ENTRY_BYTES);
        if entry_bytes > entry_limit {
            return Err(DesignStoreError::EntryTooLarge {
                entry_bytes,
                budget_bytes: entry_limit,
            });
        }

        let replaced_bytes = self.entries.get(design_id).map_or(0, |entry| entry.bytes);
        while self
            .total_bytes
            .saturating_sub(replaced_bytes)
            .saturating_add(entry_bytes)
            > self.budget_bytes
        {
            let Some(oldest) = self.oldest_except(design_id) else {
                break;
            };
            tracing::info!(design_id = oldest, "stored_design_evicted");
            self.remove(&oldest)?;
        }

        let destination = self.path_for(design_id);
        temporary.persist(&destination).map_err(|err| err.error)?;
        let sync_result = sync_directory(&self.directory);
        self.forget(design_id);
        self.total_bytes = self.total_bytes.saturating_add(entry_bytes);
        self.entries.insert(
            design_id.to_owned(),
            EntryMetadata {
                bytes: entry_bytes,
                last_accessed: now,
            },
        );
        self.order.insert((now, design_id.to_owned()));
        sync_result?;
        Ok(entry_bytes)
    }

    pub fn remove(&mut self, design_id: &str) -> Result<(), DesignStoreError> {
        if !valid_design_id(design_id) {
            return Ok(());
        }
        match fs::remove_file(self.path_for(design_id)) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
        self.forget(design_id);
        Ok(())
    }

    fn scan(&mut self) -> Result<(), DesignStoreError> {
        for entry in fs::read_dir(&self.directory)? {
            let entry = entry?;
            let path = entry.path();
            if !entry.file_type()?.is_file() {
                continue;
            }
            if entry.file_name() == FORMAT_VERSION_MARKER {
                continue;
            }
            let Some(design_id) = design_id_from_path(&path) else {
                tracing::warn!(path = %path.display(), "stored_design_stray_file_removed");
                let _ = fs::remove_file(path);
                continue;
            };
            let metadata = entry.metadata()?;
            if metadata.len() > MAX_ENTRY_BYTES {
                tracing::warn!(path = %path.display(), bytes = metadata.len(), "stored_design_oversized_file_removed");
                let _ = fs::remove_file(path);
                continue;
            }
            let last_accessed = metadata
                .modified()
                .unwrap_or(SystemTime::UNIX_EPOCH)
                .min(SystemTime::now());
            let bytes = metadata.len();
            self.total_bytes = self.total_bytes.saturating_add(bytes);
            self.entries.insert(
                design_id.clone(),
                EntryMetadata {
                    bytes,
                    last_accessed,
                },
            );
            self.order.insert((last_accessed, design_id));
        }
        Ok(())
    }

    fn prune(&mut self, now: SystemTime) -> Result<(), DesignStoreError> {
        while let Some((last_accessed, id)) = self.order.first().cloned() {
            let expired = now
                .duration_since(last_accessed)
                .is_ok_and(|age| age >= self.ttl);
            if !expired {
                break;
            }
            tracing::info!(design_id = id, "stored_design_expired");
            self.remove(&id)?;
        }
        while self.total_bytes > self.budget_bytes {
            let Some(oldest) = self.oldest_except("") else {
                break;
            };
            tracing::info!(design_id = oldest, "stored_design_evicted");
            self.remove(&oldest)?;
        }
        Ok(())
    }

    fn oldest_except(&self, excluded: &str) -> Option<String> {
        self.order
            .iter()
            .find(|(_, id)| id != excluded)
            .map(|(_, id)| id.clone())
    }

    fn forget(&mut self, design_id: &str) {
        if let Some(entry) = self.entries.remove(design_id) {
            self.order
                .remove(&(entry.last_accessed, design_id.to_owned()));
            self.total_bytes = self.total_bytes.saturating_sub(entry.bytes);
        }
    }

    fn path_for(&self, design_id: &str) -> PathBuf {
        self.directory.join(format!("{design_id}.{FILE_EXTENSION}"))
    }
}

fn ensure_format_version(directory: &Path, format_version: u32) -> Result<(), DesignStoreError> {
    let marker_path = directory.join(FORMAT_VERSION_MARKER);
    let expected = format_version.to_string();
    let current = match fs::read_to_string(&marker_path) {
        Ok(value) => Some(value),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => return Err(err.into()),
    };
    if current
        .as_deref()
        .is_some_and(|value| value.trim() == expected)
    {
        return Ok(());
    }

    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && design_id_from_path(&entry.path()).is_some() {
            fs::remove_file(entry.path())?;
        }
    }

    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(expected.as_bytes())?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary.persist(&marker_path).map_err(|err| err.error)?;
    sync_directory(directory)?;
    Ok(())
}

fn valid_design_id(design_id: &str) -> bool {
    design_id.len() == 12
        && design_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn design_id_from_path(path: &Path) -> Option<String> {
    (path.extension()?.to_str()? == FILE_EXTENSION)
        .then(|| path.file_stem()?.to_str())
        .flatten()
        .filter(|id| valid_design_id(id))
        .map(str::to_owned)
}

fn sync_directory(directory: &Path) -> std::io::Result<()> {
    File::open(directory)?.sync_all()
}

#[cfg(unix)]
fn set_private_directory_permissions(directory: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_directory: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    const A: &str = "aaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbb";
    const C: &str = "cccccccccccc";

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct TestValue {
        body: String,
    }

    #[test]
    fn entries_survive_reopen_and_invalid_ids_cannot_escape_the_directory() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = DesignStore::open(directory.path(), 1024, Duration::from_secs(60)).unwrap();
        store
            .write(
                A,
                &TestValue {
                    body: "saved".into(),
                },
            )
            .unwrap();
        drop(store);

        let mut reopened =
            DesignStore::open(directory.path(), 1024, Duration::from_secs(60)).unwrap();
        assert_eq!(
            reopened.read::<TestValue>(A).unwrap(),
            Some(TestValue {
                body: "saved".into()
            })
        );
        assert_eq!(reopened.read::<TestValue>("../escape").unwrap(), None);
        assert!(matches!(
            reopened.write(
                "../escape",
                &TestValue {
                    body: String::new()
                }
            ),
            Err(DesignStoreError::InvalidDesignId)
        ));
    }

    #[test]
    fn least_recently_used_entries_are_evicted_to_the_byte_budget() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = DesignStore::open(directory.path(), 110, Duration::from_secs(60)).unwrap();
        store
            .write(
                A,
                &TestValue {
                    body: "a".repeat(30),
                },
            )
            .unwrap();
        store
            .write(
                B,
                &TestValue {
                    body: "b".repeat(30),
                },
            )
            .unwrap();
        let _ = store.read::<TestValue>(A).unwrap();
        std::thread::sleep(Duration::from_millis(2));
        store
            .write(
                C,
                &TestValue {
                    body: "c".repeat(30),
                },
            )
            .unwrap();

        assert!(store.read::<TestValue>(A).unwrap().is_some());
        assert!(store.read::<TestValue>(B).unwrap().is_none());
        assert!(store.read::<TestValue>(C).unwrap().is_some());
        assert!(store.total_bytes <= store.budget_bytes);
    }

    #[test]
    fn startup_prunes_expired_entries_and_oversized_values_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = DesignStore::open(directory.path(), 80, Duration::from_secs(60)).unwrap();
        store.write(A, &TestValue { body: "old".into() }).unwrap();
        let path = store.path_for(A);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(120)))
            .unwrap();
        drop(store);

        let mut reopened =
            DesignStore::open(directory.path(), 80, Duration::from_secs(60)).unwrap();
        assert!(reopened.read::<TestValue>(A).unwrap().is_none());
        assert!(matches!(
            reopened.write(
                B,
                &TestValue {
                    body: "x".repeat(200)
                }
            ),
            Err(DesignStoreError::EntryTooLarge { .. })
        ));
    }

    #[test]
    fn versioned_open_purges_unversioned_entries_and_writes_marker() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join(format!("{A}.{FILE_EXTENSION}")),
            br#"{"body":"legacy raw source"}"#,
        )
        .unwrap();

        let mut store =
            DesignStore::open_versioned(directory.path(), 1024, Duration::from_secs(60), 2)
                .unwrap();

        assert!(store.read::<TestValue>(A).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(directory.path().join(FORMAT_VERSION_MARKER)).unwrap(),
            "2\n"
        );
    }

    #[test]
    fn versioned_open_retains_entries_only_for_matching_version() {
        let directory = tempfile::tempdir().unwrap();
        let mut store =
            DesignStore::open_versioned(directory.path(), 1024, Duration::from_secs(60), 2)
                .unwrap();
        store
            .write(
                A,
                &TestValue {
                    body: "saved".into(),
                },
            )
            .unwrap();
        drop(store);

        let mut reopened =
            DesignStore::open_versioned(directory.path(), 1024, Duration::from_secs(60), 2)
                .unwrap();
        assert_eq!(
            reopened.read::<TestValue>(A).unwrap(),
            Some(TestValue {
                body: "saved".into()
            })
        );
        drop(reopened);

        let mut upgraded =
            DesignStore::open_versioned(directory.path(), 1024, Duration::from_secs(60), 3)
                .unwrap();
        assert!(upgraded.read::<TestValue>(A).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(directory.path().join(FORMAT_VERSION_MARKER)).unwrap(),
            "3\n"
        );
    }
}
