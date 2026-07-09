// Editor: a single CodeMirror 6 instance whose document is swapped when the
// active tab changes. Editor-local state (cursor, selection) lives here.
//
// Diagnostics flow:
//   setDiagnostics(items) -> dispatches @codemirror/lint's setDiagnostics
//   effect with positions converted from (line, character) -> doc offsets.

import { EditorState, Compartment, EditorSelection, Annotation } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import {
  linter,
  lintGutter,
  setDiagnostics as cmSetDiagnostics,
  type Diagnostic as CMDiagnostic,
} from "@codemirror/lint";

export interface DiagnosticItem {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code: string | null;
  source: string | null;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface EditorBinding {
  setDoc(text: string, filePath: string): void;
  getDoc(): string;
  focus(): void;
  view: EditorView;
  /** Push the diagnostic set for the currently-displayed doc. */
  setDiagnostics(items: DiagnosticItem[]): void;
  /** Move caret to a 1-based (line, col); col is 1-based to match Problems UI. */
  jumpTo(line: number, col: number): void;
}

// Tag programmatic doc swaps so the change listener doesn't treat them as
// user edits (which would mark the tab dirty and re-trigger didChange).
const ProgrammaticDocSet = Annotation.define<boolean>();

// Above this size (in characters) we open files without language highlighting.
// The Lezer parser is the dominant cost for large docs; CodeMirror's own line
// virtualization handles plain text of this size comfortably.
const LARGE_FILE_PLAIN_THRESHOLD = 1_000_000;

export function mountEditor(parent: HTMLElement, onChange: () => void): EditorBinding {
  const language = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        language.of(python()),
        // Install the lint state field with a no-op source. We push the actual
        // diagnostics imperatively via setDiagnostics().
        linter(() => [], { delay: 100000 }),
        lintGutter(),
        EditorView.theme(
          {
            "&": { backgroundColor: "#1e1e1e", color: "#d4d4d4", height: "100%" },
            ".cm-content": { caretColor: "#aeafad" },
            ".cm-gutters": {
              backgroundColor: "#1e1e1e",
              color: "#5a5a5a",
              border: "none",
            },
            ".cm-activeLine": { backgroundColor: "#2a2a2a" },
            ".cm-activeLineGutter": { backgroundColor: "#2a2a2a" },
            ".cm-selectionBackground, .cm-content ::selection": {
              backgroundColor: "#264f78 !important",
            },
            ".cm-tooltip.cm-tooltip-lint": {
              backgroundColor: "#252526",
              border: "1px solid #3c3c3c",
              color: "#d4d4d4",
            },
          },
          { dark: true }
        ),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          if (u.transactions.some((t) => t.annotation(ProgrammaticDocSet))) return;
          onChange();
        }),
      ],
    }),
  });

  function clampLineChar(line: number, character: number): number {
    const doc = view.state.doc;
    const ln = Math.max(1, Math.min(line + 1, doc.lines));
    const lineObj = doc.line(ln);
    const ch = Math.max(0, Math.min(character, lineObj.length));
    return lineObj.from + ch;
  }

  return {
    view,
    setDoc(text, filePath) {
      void filePath;
      // Large files: drop the Lezer language parser. Running Python (Lezer)
      // highlighting over multi-MB files (e.g. a 19MB HTML) locks the UI. Plain
      // text has no per-token parse cost, so big files open instantly.
      const plain = text.length > LARGE_FILE_PLAIN_THRESHOLD;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        effects: language.reconfigure(plain ? [] : python()),
        annotations: ProgrammaticDocSet.of(true),
      });
      // Reset diagnostics when the document is replaced; the caller is expected
      // to push the current file's set immediately after.
      view.dispatch(cmSetDiagnostics(view.state, []));
    },
    getDoc() {
      return view.state.doc.toString();
    },
    focus() {
      view.focus();
    },
    setDiagnostics(items) {
      const mapped: CMDiagnostic[] = items.map((d) => {
        const from = clampLineChar(d.range.start.line, d.range.start.character);
        let to = clampLineChar(d.range.end.line, d.range.end.character);
        if (to <= from) to = Math.min(view.state.doc.length, from + 1);
        return {
          from,
          to,
          severity: d.severity === "hint" ? "info" : d.severity,
          message: d.message,
          source: d.source ?? d.code ?? undefined,
        };
      });
      view.dispatch(cmSetDiagnostics(view.state, mapped));
    },
    jumpTo(line, col) {
      const doc = view.state.doc;
      const ln = Math.max(1, Math.min(line, doc.lines));
      const lineObj = doc.line(ln);
      const pos = Math.min(lineObj.from + Math.max(0, col - 1), lineObj.to);
      view.dispatch({
        selection: EditorSelection.single(pos),
        scrollIntoView: true,
      });
      view.focus();
    },
  };
}
