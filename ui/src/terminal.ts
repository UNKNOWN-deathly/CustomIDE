// Terminal panel — xterm.js renders ANSI; we just bridge IO to the PTY.
//   - PTY output (process_output events) -> term.write(chunk)
//   - user keystrokes (term.onData) -> cmd_pty_write
//   - container resize (FitAddon) -> term.onResize -> cmd_pty_resize
// No business logic; no terminal emulation done by us.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { ipc, type CoreEvent } from "./ipc";

const TERMINAL_INPUT_DEBUG = true;
const CUSTOM_KEY_HANDLER_ENABLED =
  window.localStorage.getItem("customide.terminal.customKeyHandler") === "1";

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
  isFocused(): boolean;
  onFocusChange(handler: (focused: boolean) => void): void;
}

export function mountTerminal(host: HTMLElement): TerminalBinding {
  const term = new Terminal({
    fontFamily: "Consolas, Menlo, Monaco, 'Courier New', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    convertEol: false,           // PTY already supplies CRLF where needed
    scrollback: 5000,
    theme: {
      background: "#1e1e1e",
      foreground: "#e2e4e9",     // Matches --text-main
      cursor: "#8c919d",         // Softer gray cursor (matches --text-muted)
      cursorAccent: "#1e1e1e",
      selectionBackground: "rgba(75, 139, 190, 0.3)", // Integrated semi-transparent blue selection
      black: "#1e1e1e",
      red: "#f48771",
      green: "#4ea87d",          // Softer, calm Python green
      yellow: "#cca700",
      blue: "#4b8bbe",           // Softer Python blue (matches --accent-color)
      magenta: "#b180d7",
      cyan: "#4eb3cd",
      white: "#e2e4e9",
      brightBlack: "#585b62",
      brightRed: "#f48771",
      brightGreen: "#4ea87d",
      brightYellow: "#cca700",
      brightBlue: "#5c9cd0",
      brightMagenta: "#b180d7",
      brightCyan: "#4eb3cd",
      brightWhite: "#ffffff",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);

  let sessionId: string | null = null;
  let resizeHandler: ((cols: number, rows: number) => void) | null = null;
  let focusHandler: ((focused: boolean) => void) | null = null;
  let focused = false;
  let lastResize: { cols: number; rows: number } | null = null;
  const pendingEvents = new Map<string, CoreEvent[]>();

  // Initial fit — xterm needs the container laid out first.
  const safeFit = () => {
    try { fit.fit(); } catch { /* element not visible yet */ }
  };
  requestAnimationFrame(safeFit);

  term.onData((data) => {
    debugInput("onData", { sessionId, data: describeData(data) });
    if (!sessionId) {
      debugInput("onData dropped: no sessionId", { data: describeData(data) });
      return;
    }
    ipc.ptyWrite(sessionId, data).catch((err) =>
      term.write(`\r\n\x1b[31m[pty write error: ${err}]\x1b[0m\r\n`)
    );
  });

  term.onResize(({ cols, rows }) => {
    if (!sessionId) return;
    if (lastResize && lastResize.cols === cols && lastResize.rows === rows) return;
    lastResize = { cols, rows };
    resizeHandler?.(cols, rows);
  });

  if (CUSTOM_KEY_HANDLER_ENABLED) {
    term.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase();
      const copy = event.ctrlKey && event.shiftKey && key === "c";
      const paste = event.ctrlKey && event.shiftKey && key === "v";
      const handled = event.type === "keydown" && (copy || paste);
      debugInput("customKeyEvent", {
        type: event.type,
        key: event.key,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        handled,
      });
      if (event.type === "keydown" && copy) {
        copySelection();
        return false;
      }
      if (event.type === "keydown" && paste) {
        pasteFromClipboard();
        return false;
      }
      return true;
    });
  } else {
    debugInput("customKeyEvent bypassed", {
      enableWith: "localStorage customide.terminal.customKeyHandler = 1",
    });
  }

  host.addEventListener("mousedown", () => term.focus());
  host.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    term.paste(text);
  });
  host.addEventListener("copy", (event) => {
    if (!term.hasSelection()) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", term.getSelection());
  });

  host.addEventListener("focusin", () => setFocused(true));
  host.addEventListener("focusout", () => {
    requestAnimationFrame(() => setFocused(host.contains(document.activeElement)));
  });

  // Re-fit whenever the container changes size (split, window resize, panel show).
  const ro = new ResizeObserver(() => safeFit());
  ro.observe(host);

  function setFocused(next: boolean) {
    if (focused === next) return;
    focused = next;
    host.classList.toggle("terminal-focused", next);
    focusHandler?.(next);
  }

  function copySelection() {
    if (!term.hasSelection()) return;
    const text = term.getSelection();
    navigator.clipboard?.writeText(text).catch(() => {});
    term.clearSelection();
  }

  function pasteFromClipboard() {
    navigator.clipboard?.readText()
      .then((text) => {
        if (text) term.paste(text);
      })
      .catch(() => {});
  }

  function isProcessEvent(evt: CoreEvent): evt is Extract<CoreEvent, { id: string }> {
    return evt.kind === "process_started" ||
      evt.kind === "process_output" ||
      evt.kind === "process_exited";
  }

  function renderProcessEvent(evt: Extract<CoreEvent, { id: string }>) {
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
    }
  }

  function rememberPending(evt: CoreEvent) {
    if (!isProcessEvent(evt)) return;
    const events = pendingEvents.get(evt.id) ?? [];
    events.push(evt);
    if (events.length > 200) events.shift();
    pendingEvents.set(evt.id, events);
  }

  return {
    applyEvent(evt) {
      if (!isProcessEvent(evt)) return;
      if (!sessionId) {
        rememberPending(evt);
        return;
      }
      if (evt.id !== sessionId) return;
      renderProcessEvent(evt);
    },
    clear() {
      term.clear();
    },
    log(line) {
      term.write(`\x1b[32m${line}\x1b[0m${line.endsWith("\n") ? "" : "\r\n"}`);
    },
    attachSession(id) {
      debugInput("attachSession", { id, pending: pendingEvents.get(id)?.length ?? 0 });
      sessionId = id;
      lastResize = null;
      const pending = pendingEvents.get(id) ?? [];
      pendingEvents.clear();
      for (const evt of pending) {
        if (isProcessEvent(evt)) renderProcessEvent(evt);
      }
      safeFit();
      term.focus();
    },
    detachSession() {
      debugInput("detachSession", { sessionId });
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
    isFocused() {
      return focused;
    },
    onFocusChange(handler) {
      focusHandler = handler;
    },
  };
}

function debugInput(message: string, details: Record<string, unknown>) {
  if (!TERMINAL_INPUT_DEBUG) return;
  console.debug(`[terminal-input] ${message}`, details);
}

function describeData(data: string) {
  return {
    length: data.length,
    escaped: escapeForLog(data),
    codes: Array.from(data).map((ch) => ch.codePointAt(0) ?? 0),
  };
}

function escapeForLog(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\x1b/g, "\\x1b")
    .replace(/\x03/g, "\\x03")
    .replace(/\x04/g, "\\x04");
}
