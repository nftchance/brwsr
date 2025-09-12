import type { PaneState, Rect } from "./types/pane";

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
export {};

declare module "react" {
  interface CSSProperties {
    WebkitAppRegion?: "drag" | "no-drag" | string;
  }
}
