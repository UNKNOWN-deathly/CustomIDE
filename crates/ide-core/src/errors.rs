use thiserror::Error;

pub type IdeResult<T> = Result<T, IdeError>;

#[derive(Debug, Error)]
pub enum IdeError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),

    #[error("notify: {0}")]
    Notify(#[from] notify::Error),

    #[error("workspace not open")]
    NoWorkspace,

    #[error("python interpreter not found")]
    NoInterpreter,

    #[error("tool not found: {0}")]
    ToolNotFound(String),

    #[error("process exited with code {0:?}")]
    ProcessFailed(Option<i32>),

    #[error("lsp protocol error: {0}")]
    Lsp(String),

    #[error("dap protocol error: {0}")]
    Dap(String),

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("not a text file")]
    NotTextFile,

    #[error("{0}")]
    Other(String),
}

impl IdeError {
    pub fn other(msg: impl Into<String>) -> Self {
        Self::Other(msg.into())
    }
}
