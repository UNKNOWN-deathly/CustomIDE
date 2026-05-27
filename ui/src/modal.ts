// Lightweight DOM modals. No framework, no library; closes on Escape and on
// backdrop click for cancel-style flows. Returns a Promise that resolves with
// the picked outcome.

export type SaveDecision = "save" | "discard" | "cancel";

export interface ConfirmSaveOptions {
  title: string;
  message: string;
  /** Defaults to "Save". */
  saveLabel?: string;
  /** Defaults to "Don't Save". */
  discardLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
}

export interface PromptNameOptions {
  title: string;
  description?: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
}

/**
 * Three-option unsaved-changes prompt. Resolves with the user's pick.
 * Escape or backdrop click → "cancel".
 */
export function confirmSave(opts: ConfirmSaveOptions): Promise<SaveDecision> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const box = document.createElement("div");
    box.className = "modal-box";

    const title = document.createElement("h2");
    title.className = "modal-title";
    title.textContent = opts.title;
    box.appendChild(title);

    const body = document.createElement("p");
    body.className = "modal-body";
    body.textContent = opts.message;
    box.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const settle = (decision: SaveDecision) => {
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(decision);
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";
    cancelBtn.onclick = () => settle("cancel");

    const discardBtn = document.createElement("button");
    discardBtn.className = "modal-btn danger";
    discardBtn.textContent = opts.discardLabel ?? "Don't Save";
    discardBtn.onclick = () => settle("discard");

    const saveBtn = document.createElement("button");
    saveBtn.className = "modal-btn primary";
    saveBtn.textContent = opts.saveLabel ?? "Save";
    saveBtn.onclick = () => settle("save");

    actions.appendChild(cancelBtn);
    actions.appendChild(discardBtn);
    actions.appendChild(saveBtn);
    box.appendChild(actions);
    backdrop.appendChild(box);

    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) settle("cancel");
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle("cancel");
      } else if (e.key === "Enter") {
        e.preventDefault();
        settle("save");
      }
    };
    window.addEventListener("keydown", onKey, true);

    document.body.appendChild(backdrop);
    saveBtn.focus();
  });
}

export function promptName(opts: PromptNameOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const box = document.createElement("div");
    box.className = "modal-box";

    const title = document.createElement("h2");
    title.className = "modal-title";
    title.textContent = opts.title;
    box.appendChild(title);

    if (opts.description) {
      const desc = document.createElement("p");
      desc.className = "modal-body";
      desc.textContent = opts.description;
      box.appendChild(desc);
    }

    const label = document.createElement("label");
    label.className = "modal-field-label";
    label.textContent = opts.label;
    box.appendChild(label);

    const input = document.createElement("input");
    input.className = "modal-text-input";
    input.type = "text";
    input.value = opts.initialValue ?? "";
    input.spellcheck = false;
    input.autocomplete = "off";
    box.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const settle = (value: string | null) => {
      window.removeEventListener("keydown", onKey, true);
      backdrop.remove();
      resolve(value);
    };

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "modal-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.onclick = () => settle(null);

    const createBtn = document.createElement("button");
    createBtn.className = "modal-btn primary";
    createBtn.textContent = opts.confirmLabel ?? "Create";
    createBtn.onclick = () => {
      const value = input.value.trim();
      if (!value) {
        input.focus();
        input.select();
        return;
      }
      settle(value);
    };

    actions.appendChild(cancelBtn);
    actions.appendChild(createBtn);
    box.appendChild(actions);
    backdrop.appendChild(box);

    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) settle(null);
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        settle(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        createBtn.click();
      }
    };
    window.addEventListener("keydown", onKey, true);

    document.body.appendChild(backdrop);
    input.focus();
    input.select();
  });
}
