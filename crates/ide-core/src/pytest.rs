//! pytest integration — discovery via `--collect-only -q` and runs via the
//! project's interpreter `-m pytest`. Streaming output is delegated to the
//! [`crate::process::ProcessRunner`]; this module just builds specs and parses
//! collection.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};
use crate::process::{ProcessRunner, RunSpec};
use crate::python_env::PythonEnv;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestItem {
    pub nodeid: String,
    pub file: String,
    pub name: String,
}

pub fn collect(env: &PythonEnv, project_root: &Path) -> IdeResult<Vec<TestItem>> {
    let out = Command::new(&env.interpreter)
        .current_dir(project_root)
        .args(["-m", "pytest", "--collect-only", "-q", "--no-header"])
        .output()?;
    if !out.status.success() && out.stdout.is_empty() {
        return Err(IdeError::ProcessFailed(out.status.code()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut items = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("==") {
            break;
        }
        if !line.contains("::") {
            continue;
        }
        let (file, name) = line.split_once("::").unwrap();
        items.push(TestItem {
            nodeid: line.to_string(),
            file: file.to_string(),
            name: name.to_string(),
        });
    }
    Ok(items)
}

pub fn run(
    runner: &ProcessRunner,
    env: &PythonEnv,
    project_root: &Path,
    nodeids: &[String],
) -> IdeResult<String> {
    let mut args = vec!["-m".to_string(), "pytest".to_string(), "-q".to_string()];
    for n in nodeids {
        args.push(n.clone());
    }
    let spec = RunSpec {
        program: env.interpreter.to_string_lossy().into_owned(),
        args,
        cwd: Some(project_root.to_path_buf()),
        env: vec![],
    };
    runner.spawn(spec)
}
