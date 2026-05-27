//! Search service — gitignore-aware regex/literal search across the workspace,
//! built on the `ignore` walker + `grep` matcher (the libraries ripgrep is
//! built from).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};

use crate::errors::{IdeError, IdeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub literal: bool,
    #[serde(default)]
    pub case_insensitive: bool,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub path: PathBuf,
    pub line_number: u64,
    pub line: String,
    pub start: usize,
    pub end: usize,
}

pub fn search(root: &Path, query: &SearchQuery) -> IdeResult<Vec<SearchHit>> {
    let pattern = if query.literal {
        regex_escape(&query.pattern)
    } else {
        query.pattern.clone()
    };
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(query.case_insensitive)
        .build(&pattern)
        .map_err(|e| IdeError::other(format!("regex: {e}")))?;
    let cap: usize = query.max_results.unwrap_or(2000);

    let hits = Arc::new(Mutex::new(Vec::with_capacity(256)));
    let walker = WalkBuilder::new(root)
        .hidden(!query.include_hidden)
        .git_ignore(true)
        .git_exclude(true)
        .build_parallel();

    walker.run(|| {
        let matcher = matcher.clone();
        let hits = hits.clone();
        let mut searcher: Searcher = SearcherBuilder::new().line_number(true).build();
        Box::new(move |entry| {
            let Ok(entry) = entry else { return ignore::WalkState::Continue };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                return ignore::WalkState::Continue;
            }
            let path = entry.path().to_path_buf();
            let mut sink = CollectSink { matcher: &matcher, hits: hits.clone(), path: &path, cap };
            let _ = searcher.search_path(&matcher, &path, &mut sink);
            if hits.lock().unwrap().len() >= cap {
                ignore::WalkState::Quit
            } else {
                ignore::WalkState::Continue
            }
        })
    });

    let mut out = Arc::try_unwrap(hits)
        .map_err(|_| IdeError::other("search hits Arc still shared"))?
        .into_inner()
        .map_err(|e| IdeError::other(format!("mutex poisoned: {e}")))?;
    if out.len() > cap {
        out.truncate(cap);
    }
    Ok(out)
}

struct CollectSink<'a, M: Matcher> {
    matcher: &'a M,
    hits: Arc<Mutex<Vec<SearchHit>>>,
    path: &'a Path,
    cap: usize,
}

impl<'a, M: Matcher> Sink for CollectSink<'a, M> {
    type Error = std::io::Error;
    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, std::io::Error> {
        let bytes = mat.bytes();
        let line = String::from_utf8_lossy(bytes).trim_end_matches(['\r', '\n']).to_string();
        let mut start = 0usize;
        let mut end = 0usize;
        let _ = self.matcher.find(bytes).map(|m| {
            if let Some(m) = m {
                start = m.start();
                end = m.end();
            }
        });
        let mut guard = self.hits.lock().unwrap();
        guard.push(SearchHit {
            path: self.path.to_path_buf(),
            line_number: mat.line_number().unwrap_or(0),
            line,
            start,
            end,
        });
        Ok(guard.len() < self.cap)
    }
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if matches!(
            c,
            '.' | '+' | '*' | '?' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}
