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

// Visual severity icons in SVG format
const errorIcon = `
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f48771" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="15" y1="9" x2="9" y2="15"></line>
    <line x1="9" y1="9" x2="15" y2="15"></line>
  </svg>
`;

const warningIcon = `
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#cca700" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
    <line x1="12" y1="9" x2="12" y2="13"></line>
    <line x1="12" y1="17" x2="12.01" y2="17"></line>
  </svg>
`;

const infoIcon = `
  <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#007acc" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10"></circle>
    <line x1="12" y1="16" x2="12" y2="12"></line>
    <line x1="12" y1="8" x2="12.01" y2="8"></line>
  </svg>
`;

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
        
        // Severity Icon
        const iconSpan = document.createElement("span");
        iconSpan.className = "problem-icon";
        if (diagnostic.severity === "error") {
          iconSpan.innerHTML = errorIcon;
        } else if (diagnostic.severity === "warning") {
          iconSpan.innerHTML = warningIcon;
        } else {
          iconSpan.innerHTML = infoIcon;
        }
        row.appendChild(iconSpan);

        // Location Info
        const loc = document.createElement("span");
        loc.className = "loc";
        const line = diagnostic.range.start.line + 1;
        const col = diagnostic.range.start.character + 1;
        loc.textContent = `${shorten(path)}:${line}:${col}`;
        row.appendChild(loc);

        // Message
        const msg = document.createElement("span");
        msg.className = "msg";
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
