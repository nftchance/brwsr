import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

import { PaneState, Rect, Leaf } from "./pane/types";

const arg = process.argv.find((a) => a.startsWith("--paneId="));
const paneId = arg ? Number(arg.split("=")[1]) : -1;

export const invoke = {
  getCurrentPaneId: () => paneId,
  createPane: (url: string, rect: Rect) =>
    ipcRenderer.invoke("panes:create", { url, undefined }) as Promise<number>,
  listPanes: () => ipcRenderer.invoke("panes:list") as Promise<PaneState[]>,
  getPane: (id: number) =>
    ipcRenderer.invoke("pane:get", { id }) as Promise<Leaf | undefined>,
  navigatePanes: (id: number, dir: "left" | "right" | "up" | "down") =>
    ipcRenderer.invoke("panes:navigate", { id, dir }) as Promise<void>,
  navigatePane: (id: number, url: string) =>
    ipcRenderer.invoke("pane:navigate", { id, url }) as Promise<void>,
  scrollPane: (id: number, deltaY: number) =>
    ipcRenderer.invoke("pane:scroll", { id, deltaY }) as Promise<void>,
  activePane: (id: number) =>
    ipcRenderer.invoke("pane:active", { id }) as Promise<void>,
  closePane: (id: number) =>
    ipcRenderer.invoke("pane:close", { id }) as Promise<void>,
  splitPane: (
    id: number,
    dir: "vertical" | "horizontal",
    side: "left" | "right" | "up" | "down"
  ) => ipcRenderer.invoke("pane:split", { id, dir, side }) as Promise<void>,
  resizePane: (id: number, dir: "left" | "right" | "up" | "down") =>
    ipcRenderer.invoke("pane:resize", { id, dir }) as Promise<void>,

  onPanes: (cb: (state: PaneState[]) => void) => {
    const handler = (_e: IpcRendererEvent, state: PaneState[]) => cb(state);
    ipcRenderer.on("panes:update", handler);
    return () => ipcRenderer.removeListener("panes:update", handler);
  },
  onOverlayFocus: (cb: (focused: boolean) => void) => {
    const handler = (_e: IpcRendererEvent, focused: boolean) => cb(focused);
    ipcRenderer.on("pane:overlay:focus", handler);
    return () => ipcRenderer.removeListener("pane:overlay:focus", handler);
  },
  onActive: (cb: (id: number) => void) => {
    const handler = (_e: IpcRendererEvent, id: number) => cb(id);
    ipcRenderer.on("panes:active", handler);
    return () => ipcRenderer.removeListener("panes:active", handler);
  },
};

contextBridge.exposeInMainWorld("native", invoke);

declare global {
  interface Window {
    native: typeof invoke;
  }
}
