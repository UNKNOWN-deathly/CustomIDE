//! Settings store — JSON-backed, two tiers (user + workspace), merged on read.
//! Atomic write via tmp+rename. No schema enforcement yet (intentional — v1).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::errors::IdeResult;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    #[serde(flatten)]
    pub values: Map<String, Value>,
}

impl Settings {
    pub fn read(&self, key: &str) -> Option<Value> {
        let mut cur = Value::Object(self.values.clone());
        for part in key.split('.') {
            cur = cur.get(part)?.clone();
        }
        Some(cur)
    }

    pub fn set(&mut self, key: &str, value: Value) {
        let parts: Vec<&str> = key.split('.').collect();
        if parts.len() == 1 {
            self.values.insert(parts[0].to_string(), value);
            return;
        }
        let mut cur: &mut Map<String, Value> = &mut self.values;
        for part in &parts[..parts.len() - 1] {
            let entry = cur
                .entry((*part).to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !entry.is_object() {
                *entry = Value::Object(Map::new());
            }
            cur = entry.as_object_mut().unwrap();
        }
        cur.insert(parts.last().unwrap().to_string(), value);
    }
}

#[derive(Clone)]
pub struct SettingsStore {
    user_path: PathBuf,
    workspace_path: Arc<RwLock<Option<PathBuf>>>,
    user: Arc<RwLock<Settings>>,
    workspace: Arc<RwLock<Settings>>,
}

impl SettingsStore {
    pub fn new(user_path: PathBuf) -> IdeResult<Self> {
        let user = load(&user_path).unwrap_or_default();
        Ok(Self {
            user_path,
            workspace_path: Arc::new(RwLock::new(None)),
            user: Arc::new(RwLock::new(user)),
            workspace: Arc::new(RwLock::new(Settings::default())),
        })
    }

    pub fn default_user_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("ide-core")
            .join("settings.json")
    }

    pub fn bind_workspace(&self, workspace_root: &Path) -> IdeResult<()> {
        let p = workspace_root.join(".ide").join("settings.json");
        let loaded = load(&p).unwrap_or_default();
        *self.workspace.write() = loaded;
        *self.workspace_path.write() = Some(p);
        Ok(())
    }

    pub fn merged(&self) -> Settings {
        let mut merged = self.user.read().clone();
        let ws = self.workspace.read().clone();
        for (k, v) in ws.values.into_iter() {
            merged.values.insert(k, v);
        }
        merged
    }

    pub fn get(&self, key: &str) -> Option<Value> {
        self.merged().read(key)
    }

    pub fn get_user(&self, key: &str) -> Option<Value> {
        self.user.read().read(key)
    }

    pub fn user_path(&self) -> PathBuf {
        self.user_path.clone()
    }

    pub fn set_user(&self, key: &str, value: Value) -> IdeResult<()> {
        self.user.write().set(key, value);
        save(&self.user_path, &*self.user.read())
    }

    pub fn set_workspace(&self, key: &str, value: Value) -> IdeResult<()> {
        let path = self
            .workspace_path
            .read()
            .clone()
            .ok_or_else(|| crate::errors::IdeError::NoWorkspace)?;
        self.workspace.write().set(key, value);
        save(&path, &*self.workspace.read())
    }
}

fn load(path: &Path) -> IdeResult<Settings> {
    let text = std::fs::read_to_string(path)?;
    let s: Settings = serde_json::from_str(&text)?;
    Ok(s)
}

fn save(path: &Path, settings: &Settings) -> IdeResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(settings)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
