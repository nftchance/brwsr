import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

type Rect = { x: number; y: number; width: number; height: number };
type PaneState = { id: number; url: string; title: string; rect: Rect };

contextBridge.exposeInMainWorld("native", {
  createPane: (url: string, rect: Rect) =>
    ipcRenderer.invoke("panes:create", { url, rect }) as Promise<number>,
  navigatePane: (id: number, url: string) =>
    ipcRenderer.invoke("panes:navigate", { id, url }) as Promise<void>,
  closePane: (id: number) =>
    ipcRenderer.invoke("panes:close", id) as Promise<void>,
  setLayout: (layout: { id: number; rect: Rect }[]) =>
    ipcRenderer.invoke("panes:setLayout", layout) as Promise<void>,
  listPanes: () => ipcRenderer.invoke("panes:list") as Promise<PaneState[]>,
  scrollPane: (id: number, deltaY: number) =>
    ipcRenderer.invoke("panes:scroll", { id, deltaY }) as Promise<void>,
  setActivePane: (id: number) =>
    ipcRenderer.invoke("panes:setActive", id) as Promise<void>,
  panesSplit: (id: number, dir: "vertical" | "horizontal") =>
    ipcRenderer.invoke("panes:split", { id, dir }) as Promise<void>,
  onPanes: (cb: (state: PaneState[]) => void) => {
    const handler = (_e: IpcRendererEvent, state: PaneState[]) => cb(state);
    ipcRenderer.on("panes:update", handler);
    return () => ipcRenderer.removeListener("panes:update", handler);
  },
  onActive: (cb: (id: number) => void) => {
    const handler = (_e: IpcRendererEvent, id: number) => cb(id);
    ipcRenderer.on("panes:active", handler);
    return () => ipcRenderer.removeListener("panes:active", handler);
  },
  onFocusOmni: (cb: (id: number) => void) => {
    const handler = (_e: IpcRendererEvent, id: number) => cb(id);
    ipcRenderer.on("panes:focusOmni", handler);
    return () => ipcRenderer.removeListener("panes:focusOmni", handler);
  },
  omniboxFocus: (focused: boolean) => {
    ipcRenderer.send("omnibox:focus", focused);
  },
});

declare global {
  interface Window {
    native: {
      createPane: (url: string, rect: Rect) => Promise<number>;
      navigatePane: (id: number, url: string) => Promise<void>;
      closePane: (id: number) => Promise<void>;
      setLayout: (layout: { id: number; rect: Rect }[]) => Promise<void>;
      listPanes: () => Promise<PaneState[]>;
      scrollPane: (id: number, deltaY: number) => Promise<void>;
      setActivePane: (id: number) => Promise<void>;
      panesSplit: (id: number, dir: "vertical" | "horizontal") => Promise<void>;
      onPanes: (cb: (state: PaneState[]) => void) => () => void;
      onActive: (cb: (id: number) => void) => () => void;
      onFocusOmni: (cb: (id: number) => void) => () => void;
      omniboxFocus: (focused: boolean) => void;
    };
  }
}
