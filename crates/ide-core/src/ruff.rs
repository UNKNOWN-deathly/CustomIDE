//! Ruff integration — subprocess wrapper around `ruff check --output-format json`
//! and `ruff format`. Falls back to looking for ruff in the project venv first,
//! then PATH.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuffDiagnostic {
    pub filename: String,
    pub code: Option<String>,
    pub message: String,
    pub location: Location,
    pub end_location: Location,
    #[serde(default)]
    pub fix: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Location {
    pub row: u64,
    pub column: u64,
}

pub fn find_ruff(project_root: &Path) -> IdeResult<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![
            project_root.join(".venv").join("Scripts").join("ruff.exe"),
            project_root.join("venv").join("Scripts").join("ruff.exe"),
        ]
    } else {
        vec![
            project_root.join(".venv").join("bin").join("ruff"),
            project_root.join("venv").join("bin").join("ruff"),
        ]
    };
    for c in candidates {
        if c.is_file() {
            return Ok(c);
        }
    }
    which::which("ruff").map_err(|_| IdeError::ToolNotFound("ruff".into()))
}

pub fn check(project_root: &Path, paths: &[&Path]) -> IdeResult<Vec<RuffDiagnostic>> {
    let ruff = find_ruff(project_root)?;
    let mut cmd = Command::new(ruff);
    cmd.current_dir(project_root)
        .args(["check", "--output-format", "json", "--no-cache", "--exit-zero"]);
    if paths.is_empty() {
        cmd.arg(".");
    } else {
        for p in paths {
            cmd.arg(p);
        }
    }
    let out = cmd.output()?;
    if out.stdout.is_empty() {
        return Ok(Vec::new());
    }
    let diags: Vec<RuffDiagnostic> = serde_json::from_slice(&out.stdout)?;
    Ok(diags)
}

pub fn format(project_root: &Path, paths: &[&Path]) -> IdeResult<()> {
    let ruff = find_ruff(project_root)?;
    let mut cmd = Command::new(ruff);
    cmd.current_dir(project_root).arg("format");
    if paths.is_empty() {
        cmd.arg(".");
    } else {
        for p in paths {
            cmd.arg(p);
        }
    }
    let status = cmd.status()?;
    if !status.success() {
        return Err(IdeError::ProcessFailed(status.code()));
    }
    Ok(())
}
