import { ipcRenderer } from "electron";

import * as preload from "./index";
import { activate, deactivate, updateTyped } from "./biscuits";

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

ipcRenderer.on("pane:scroll", (_e, payload: { deltaY: number }) => {
    if (isTypingContext()) return;

    const dy = typeof payload?.deltaY === "number" ? payload.deltaY : 0;
    if (!dy) return;

    window.scrollBy(0, dy);
});

// Biscuit mode handlers
ipcRenderer.on("pane:biscuits:activate", (_e) => {
    activate();
});

ipcRenderer.on("pane:biscuits:deactivate", (_e) => {
    deactivate();
});

ipcRenderer.on("pane:biscuits:update", (_e, data: { typed: string }) => {
    updateTyped(data.typed);
});

