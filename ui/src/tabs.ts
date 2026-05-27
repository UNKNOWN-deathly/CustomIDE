// Tabs: open files, switch, close, modified marker. The model is editor-local
// state (the rule says: TS owns rendering + editor-local state only).

import { ipc } from "./ipc";

export interface Tab {
  path: string;
  name: string;
  content: string; // last-saved snapshot
  dirty: boolean;
}

export interface TabsBinding {
  open(path: string): Promise<void>;
  close(path: string): void;
  active(): Tab | null;
  setActive(path: string): void;
  markDirty(dirty: boolean): void;
  saveActive(currentEditorText: string): Promise<void>;
  all(): Tab[];
  onActiveChange(handler: (tab: Tab | null) => void): void;
  render(): void;
}

export function mountTabs(host: HTMLElement): TabsBinding {
  const tabs = new Map<string, Tab>();
  let activePath: string | null = null;
  let listener: ((t: Tab | null) => void) | null = null;

  function render() {
    host.innerHTML = "";
    for (const tab of tabs.values()) {
      const el = document.createElement("div");
      el.className =
        "tab" +
        (tab.path === activePath ? " active" : "") +
        (tab.dirty ? " modified" : "");
      el.title = tab.path;
      
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tab.name;
      el.appendChild(label);
      
      const indicator = document.createElement("span");
      indicator.className = "tab-indicator";
      
      const close = document.createElement("span");
      close.className = "close";
      close.textContent = "×";
      close.onclick = (e) => {
        e.stopPropagation();
        api.close(tab.path);
      };
      
      indicator.appendChild(close);
      el.appendChild(indicator);
      el.onclick = () => api.setActive(tab.path);
      host.appendChild(el);
    }
  }

  const api: TabsBinding = {
    async open(path: string) {
      if (!tabs.has(path)) {
        const content = await ipc.fsRead(path);
        const name = path.split(/[\\/]/).pop() ?? path;
        tabs.set(path, { path, name, content, dirty: false });
      }
      api.setActive(path);
    },
    close(path: string) {
      tabs.delete(path);
      if (activePath === path) {
        const next = tabs.keys().next().value ?? null;
        activePath = next;
        listener?.(next ? tabs.get(next)! : null);
      }
      render();
    },
    active() {
      return activePath ? tabs.get(activePath) ?? null : null;
    },
    setActive(path: string) {
      if (!tabs.has(path)) return;
      activePath = path;
      render();
      listener?.(tabs.get(path)!);
    },
    markDirty(dirty: boolean) {
      const tab = api.active();
      if (!tab) return;
      if (tab.dirty !== dirty) {
        tab.dirty = dirty;
        render();
      }
    },
    async saveActive(currentEditorText: string) {
      const tab = api.active();
      if (!tab) return;
      await ipc.fsWrite(tab.path, currentEditorText);
      tab.content = currentEditorText;
      tab.dirty = false;
      render();
    },
    all() {
      return Array.from(tabs.values());
    },
    onActiveChange(handler) {
      listener = handler;
    },
    render,
  };
  return api;
}
