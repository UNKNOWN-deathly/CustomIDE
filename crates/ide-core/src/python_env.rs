//! Python environment detection.
//!
//! Looks for, in order: explicit override → `.venv` / `venv` in project →
//! `uv` managed env (via `uv python find` if available) → system `python`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PythonEnv {
    pub interpreter: PathBuf,
    pub version: Option<String>,
    pub source: EnvSource,
    pub venv_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnvSource {
    LocalVenv,
    Uv,
    System,
    Override,
}

pub fn detect(project_root: &Path) -> IdeResult<PythonEnv> {
    detect_with_override(project_root, None)
}

pub fn detect_with_override(
    project_root: &Path,
    override_interpreter: Option<&Path>,
) -> IdeResult<PythonEnv> {
    if let Some(p) = override_interpreter {
        return Ok(probe(p, EnvSource::Override, None));
    }
    for name in [".venv", "venv"] {
        let candidate = project_root.join(name);
        if candidate.is_dir() {
            if let Some(interp) = interpreter_in_venv(&candidate) {
                return Ok(probe(&interp, EnvSource::LocalVenv, Some(candidate)));
            }
        }
    }
    if let Some(uv) = try_uv(project_root) {
        return Ok(uv);
    }
    if let Ok(p) = which::which("python3").or_else(|_| which::which("python")) {
        return Ok(probe(&p, EnvSource::System, None));
    }
    Err(IdeError::NoInterpreter)
}

fn interpreter_in_venv(venv: &Path) -> Option<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![venv.join("Scripts").join("python.exe")]
    } else {
        vec![venv.join("bin").join("python3"), venv.join("bin").join("python")]
    };
    candidates.into_iter().find(|p| p.is_file())
}

fn try_uv(project_root: &Path) -> Option<PythonEnv> {
    let uv = which::which("uv").ok()?;
    let out = Command::new(&uv)
        .current_dir(project_root)
        .args(["python", "find"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path_str.is_empty() {
        return None;
    }
    let p = PathBuf::from(path_str);
    Some(probe(&p, EnvSource::Uv, None))
}

fn probe(interp: &Path, source: EnvSource, venv_root: Option<PathBuf>) -> PythonEnv {
    let version = Command::new(interp)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                let s2 = String::from_utf8_lossy(&o.stderr).trim().to_string();
                if s2.is_empty() { None } else { Some(s2) }
            } else {
                Some(s)
            }
        });
    PythonEnv {
        interpreter: interp.to_path_buf(),
        version,
        source,
        venv_root,
    }
}
