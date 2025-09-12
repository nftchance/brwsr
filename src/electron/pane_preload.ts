// src/electron/pane_preload.ts
// Cmd+H/J/K/L = split (left/down/up/right). Shift+H/J/K/L = navigate active.
// Never fires while typing (incl. shadow DOM / rich editors).

import { ipcRenderer } from "electron";

const arg = process.argv.find((a) => a.startsWith("--paneId="));
const paneId = arg ? Number(arg.split("=")[1]) : -1;

const SCROLL_STEP = 80;

function deepestActiveElement(root: Document | ShadowRoot): Element | null {
  let ae: any = root.activeElement;
  while (ae && ae.shadowRoot && ae.shadowRoot.activeElement) {
    ae = ae.shadowRoot.activeElement;
  }
  return ae as Element | null;
}

function isTypingContext(): boolean {
  const el = deepestActiveElement(document);
  if (!el) return false;

  // contentEditable
  // @ts-ignore
  if ((el as any).isContentEditable) return true;
  const ce = el.getAttribute?.("contenteditable");
  if (ce === "" || ce === "true") return true;

  const tag = el.tagName?.toLowerCase();
  if (tag === "textarea") return true;

  if (tag === "input") {
    const t = (el as HTMLInputElement).type?.toLowerCase();
    if (!t) return true;
    if (
      [
        "text",
        "search",
        "url",
        "email",
        "password",
        "tel",
        "number",
        "date",
        "datetime-local",
        "month",
        "time",
        "week",
      ].includes(t)
    )
      return true;
  }

  if (el.getAttribute?.("role") === "textbox") return true;
  return false;
}

window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    // If typing or site handled it, bail.
    if (isTypingContext()) return;
    if (e.defaultPrevented) return;

    // --- Resize keybinds: Cmd+Shift + H/J/K/L ---
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
      const k = e.key.toUpperCase();
      if (k === "H" || k === "J" || k === "K" || k === "L") {
        e.preventDefault();
        const dir =
          k === "H" ? "left" : k === "L" ? "right" : k === "K" ? "up" : "down";
        ipcRenderer.send("pane:kb-resize", { paneId, dir });
        return;
      }
    }

    // --- Split keybinds: Cmd + H/J/K/L ---
    if (!e.shiftKey && e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = e.key.toUpperCase();
      if (k === "H") {
        e.preventDefault();
        ipcRenderer.send("pane:kb-split", {
          paneId,
          dir: "vertical",
          side: "left",
        });
        return;
      }
      if (k === "L") {
        e.preventDefault();
        ipcRenderer.send("pane:kb-split", {
          paneId,
          dir: "vertical",
          side: "right",
        });
        return;
      }
      if (k === "K") {
        e.preventDefault();
        ipcRenderer.send("pane:kb-split", {
          paneId,
          dir: "horizontal",
          side: "up",
        });
        return;
      }
      if (k === "J") {
        e.preventDefault();
        ipcRenderer.send("pane:kb-split", {
          paneId,
          dir: "horizontal",
          side: "down",
        });
        return;
      }
    }

    // --- Navigate keybinds: Shift + H/J/K/L ---
    if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const k = e.key.toUpperCase();
      if (k === "H" || k === "J" || k === "K" || k === "L") {
        e.preventDefault();
        const dir =
          k === "H" ? "left" : k === "L" ? "right" : k === "K" ? "up" : "down";
        ipcRenderer.send("pane:kb-nav", { paneId, dir });
        return;
      }
    }

    // --- Scroll/Space keybinds: plain j/k/space (no modifiers) ---
    if (!e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const deltaY = e.key === "j" ? SCROLL_STEP : -SCROLL_STEP;
        ipcRenderer.send("pane:kb-scroll", { paneId, deltaY });
        return;
      }
      // Prevent default page scroll on Space; request omnibox focus globally via main
      if (e.key === " ") {
        e.preventDefault();
        ipcRenderer.send("pane:req-focus-omni", { paneId });
        return;
      }
    }

    // Close current pane
    if (
      !e.shiftKey &&
      e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      e.key.toLowerCase() === "w"
    ) {
      e.preventDefault();
      ipcRenderer.send("pane:kb-close", { paneId });
      return;
    }
  },
  { capture: false }
);

// Hover/click activation removed by design.

// Receive scroll requests targeted at this pane (from main)
ipcRenderer.on("pane:scroll", (_e, payload: { deltaY: number }) => {
  if (isTypingContext()) return;
  const dy = typeof payload?.deltaY === "number" ? payload.deltaY : 0;
  if (!dy) return;
  window.scrollBy(0, dy);
});
