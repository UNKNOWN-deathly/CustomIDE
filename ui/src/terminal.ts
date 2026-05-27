// Terminal panel — xterm.js renders ANSI; we just bridge IO to the PTY.
//   - PTY output (process_output events) -> term.write(chunk)
//   - user keystrokes (term.onData) -> cmd_pty_write
//   - container resize (FitAddon) -> term.onResize -> cmd_pty_resize
// No business logic; no terminal emulation done by us.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { ipc, type CoreEvent } from "./ipc";

export interface TerminalBinding {
  applyEvent(evt: CoreEvent): void;
  clear(): void;
  log(line: string): void;
  attachSession(id: string): void;
  detachSession(): void;
  focus(): void;
  /** Current xterm dimensions; used to size a new PTY at spawn time. */
  dimensions(): { cols: number; rows: number };
  /** Force a re-fit (call after the panel becomes visible). */
  fit(): void;
  onResize(handler: (cols: number, rows: number) => void): void;
}

export function mountTerminal(host: HTMLElement): TerminalBinding {
  const term = new Terminal({
    fontFamily: "Consolas, Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    convertEol: false,           // PTY already supplies CRLF where needed
    scrollback: 5000,
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#aeafad",
      selectionBackground: "#264f78",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  let sessionId: string | null = null;
  let resizeHandler: ((cols: number, rows: number) => void) | null = null;

  // Initial fit — xterm needs the container laid out first.
  const safeFit = () => {
    try { fit.fit(); } catch { /* element not visible yet */ }
  };
  requestAnimationFrame(safeFit);

  term.onData((data) => {
    if (!sessionId) return;
    ipc.ptyWrite(sessionId, data).catch((err) =>
      term.write(`\r\n\x1b[31m[pty write error: ${err}]\x1b[0m\r\n`)
    );
  });

  term.onResize(({ cols, rows }) => {
    resizeHandler?.(cols, rows);
  });

  // Re-fit whenever the container changes size (split, window resize, panel show).
  const ro = new ResizeObserver(() => safeFit());
  ro.observe(host);

  return {
    applyEvent(evt) {
      switch (evt.kind) {
        case "process_started":
          term.write(`\x1b[32m> ${evt.cmd}\x1b[0m\r\n`);
          break;
        case "process_output":
          term.write(evt.line);
          break;
        case "process_exited":
          term.write(`\r\n\x1b[2m[exit ${evt.code ?? "?"}]\x1b[0m\r\n`);
          if (sessionId && evt.id === sessionId) sessionId = null;
          break;
        default:
          break;
      }
    },
    clear() {
      term.clear();
    },
    log(line) {
      term.write(`\x1b[32m${line}\x1b[0m${line.endsWith("\n") ? "" : "\r\n"}`);
    },
    attachSession(id) {
      sessionId = id;
      safeFit();
      term.focus();
    },
    detachSession() {
      sessionId = null;
    },
    focus() {
      term.focus();
    },
    dimensions() {
      return { cols: term.cols, rows: term.rows };
    },
    fit: safeFit,
    onResize(handler) {
      resizeHandler = handler;
    },
  };
}
