//! Command registry — named handlers the UI/CLI invoke by id with JSON args.
//!
//! Mirrors the blueprint: UI is dumb and just sends commands. The core executes
//! and emits events. Handlers take `serde_json::Value` and return `Value` so
//! adding a command is a single registration call.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::Value;

use crate::errors::{IdeError, IdeResult};

pub type Handler = Arc<dyn Fn(Value) -> IdeResult<Value> + Send + Sync>;

#[derive(Clone, Default)]
pub struct CommandRegistry {
    inner: Arc<RwLock<HashMap<String, Handler>>>,
}

impl CommandRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register<F>(&self, name: impl Into<String>, handler: F)
    where
        F: Fn(Value) -> IdeResult<Value> + Send + Sync + 'static,
    {
        self.inner.write().insert(name.into(), Arc::new(handler));
    }

    pub fn invoke(&self, name: &str, args: Value) -> IdeResult<Value> {
        let handler = self
            .inner
            .read()
            .get(name)
            .cloned()
            .ok_or_else(|| IdeError::other(format!("unknown command: {name}")))?;
        handler(args)
    }

    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = self.inner.read().keys().cloned().collect();
        names.sort();
        names
    }
}
