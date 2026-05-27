// Problems panel: flat list of diagnostics across all known files. Caller
// (main.ts) owns the source-of-truth map and pushes a snapshot on every
// change. Clicking a row jumps via the onJump callback.

import type { CoreDiagnostic } from "./ipc";

export interface ProblemEntry {
  path: string;
  diagnostic: CoreDiagnostic;
}

export interface ProblemsBinding {
  setEntries(entries: ProblemEntry[]): void;
  clear(): void;
  onJump(handler: (path: string, line: number, col: number) => void): void;
}

export function mountProblems(host: HTMLElement): ProblemsBinding {
  let jumpHandler: ((p: string, l: number, c: number) => void) | null = null;

  return {
    setEntries(entries) {
      host.innerHTML = "";
      if (entries.length === 0) {
        const empty = document.createElement("div");
        empty.className = "placeholder";
        empty.textContent = "No problems.";
        host.appendChild(empty);
        return;
      }
      for (const { path, diagnostic } of entries) {
        const row = document.createElement("div");
        row.className = `problem-row sev-${diagnostic.severity}`;
        const loc = document.createElement("span");
        loc.className = "loc";
        const line = diagnostic.range.start.line + 1;
        const col = diagnostic.range.start.character + 1;
        loc.textContent = `${shorten(path)}:${line}:${col}`;
        const msg = document.createElement("span");
        const codeSpan = document.createElement("span");
        codeSpan.className = "code";
        const tag = diagnostic.code
          ? `[${diagnostic.source ?? "?"} ${diagnostic.code}] `
          : diagnostic.source
          ? `[${diagnostic.source}] `
          : "";
        codeSpan.textContent = tag;
        msg.appendChild(codeSpan);
        msg.appendChild(document.createTextNode(diagnostic.message));
        row.appendChild(loc);
        row.appendChild(msg);
        row.onclick = () => jumpHandler?.(path, line, col);
        host.appendChild(row);
      }
    },
    clear() {
      host.innerHTML = "";
    },
    onJump(handler) {
      jumpHandler = handler;
    },
  };
}

function shorten(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts.slice(-2).join("/");
}
