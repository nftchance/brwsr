import { BaseWindow, ipcMain, Menu, WebContentsView } from "electron";

import { Leaf, Split, Node, Rect, PaneState, SearchState } from "../pane/types";
import {
    sendState,
    replaceChild,
    findParent,
    layout,
    nudgeSplitSize,
    replaceNode,
} from "../pane/layout";
import { Pane } from "../pane/pane";
import { allocId, contentSize, error } from "../pane/utils";
import { isLikelyUrl, normalizeUrlSmart, buildGoogleSearchUrl } from "../utils/url";

import * as path from "path";

export class Window {
    paneById = new Map<number, Pane>();
    lastActivePaneId: number | null = null;
    searchStates = new Map<number, SearchState>();
    searchDebounceTimers = new Map<number, NodeJS.Timeout>();
    overlayStates = new Map<number, boolean>(); // Track which panes have overlay open
    biscuitStates = new Map<number, { active: boolean; typed: string }>(); // Track biscuit mode per pane

    window: BaseWindow;
    root: Node | null = null;

    constructor() {
        Menu.setApplicationMenu(null);
        this.window = new BaseWindow({
            width: 1200,
            height: 800,
            frame: false,
            titleBarStyle: "hidden",
            backgroundColor: "#00000000",
        });
        this.window.on("closed", () => {
            this.paneById.forEach((pane) => pane.close());
            this.window?.getChildWindows().forEach((child) => child.close());
        });

        try {
            if (process.platform === "darwin")
                this.window.setWindowButtonVisibility(false);
        } catch { }

        this.window.on("resize", () => sendState(this.window, this.root));
    }

    init = async () => {
        const first = await this.create("https://staging.onplug.io");
        await this.split(first, "vertical", "right", "https://onplug.io");

        ipcMain.handle("panes:create", this.handlePanesCreate);
        ipcMain.handle("panes:list", this.handlePanesList);
        ipcMain.handle("pane:get", this.handlePaneGet);
        ipcMain.handle("pane:overlay", this.handlePaneOverlay);
        ipcMain.handle("pane:navigate", this.handlePaneNavigate);
        ipcMain.handle("pane:active", this.handlePaneActive);
        ipcMain.handle("search:input", this.handleSearchInput);
        ipcMain.handle("search:submit", this.handleSearchSubmit);
        ipcMain.handle("search:blur", this.handleSearchBlur);

        ipcMain.on("panes:navigate", this.onPanesNavigate);
        ipcMain.on("pane:biscuits", this.onPaneBiscuits);
        ipcMain.on("pane:scroll", this.onPaneScroll);
        ipcMain.on("pane:close", this.onPaneClose);
        ipcMain.on("pane:split", this.onPaneSplit);
        ipcMain.on("pane:resize", this.onPaneResize);
        ipcMain.on("pane:biscuits:completed", this.onBiscuitsCompleted);
    };

    create = async (url: string) => {
        if (!this.root) {
            const pane = await this.make(url);

            this.root = pane.leaf;
            this.lastActivePaneId = pane.id;

            sendState(this.window, this.root);

            return pane.id;
        }

        const last = Array.from(this.paneById.values()).slice(-1)[0];
        return this.split(last.id, "vertical", "right", url);
    };

    make = async (url: string): Promise<Pane> => {
        if (!this.window) throw new Error("No window to attach pane to");

        const id = allocId();

        const view = new WebContentsView({
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                partition: "persist:default",
                preload: path.join(__dirname, "preload", "pane.js"),
                additionalArguments: [`--paneId=${id}`],
            },
        });

        const leaf: Leaf = { kind: "leaf", id, view, url };
        const pane = new Pane(this.window, leaf);
        this.paneById.set(id, pane);

        this.searchStates.set(id, {
            query: url,
            paneId: id,
            isFocused: false
        });
        this.overlayStates.set(id, false);
        this.biscuitStates.set(id, { active: false, typed: "" });

        this.subscribe(pane);
        await view.webContents.loadURL(url);
        leaf.title = view.webContents.getTitle();

        this.focus(pane.id);

        sendState(this.window, this.root, pane);

        return pane;
    };

    focus = (id: number) => {
        const pane = this.paneById.get(id);

        if (!pane) return;

        this.lastActivePaneId = pane.id;

        try {
            this.window?.focus();
        } catch { }

        try {
            pane?.leaf.view?.webContents?.focus?.();
        } catch { }
    };

    split = async (
        id: number,
        dir: "vertical" | "horizontal",
        side: "left" | "right" | "up" | "down",
        url?: string
    ) => {
        if (!this.root) return -1;

        const child = this.paneById.get(id);
        if (!child) return -1;

        const target = child.leaf;

        const parent = findParent(this.root, id);
        const pane = await this.make(url || "https://perplexity.com");
        const other = pane.leaf;

        let node: Split;

        if (dir === "vertical") {
            if (side === "left")
                node = { kind: "split", dir, size: 0.5, a: other, b: target };
            else node = { kind: "split", dir, size: 0.5, a: target, b: other };
        } else {
            if (side === "up")
                node = { kind: "split", dir, size: 0.5, a: other, b: target };
            else node = { kind: "split", dir, size: 0.5, a: target, b: other };
        }

        if (!parent) this.root = node;
        else replaceChild(parent, target, node);

        this.lastActivePaneId = other.id;

        this.focus(other.id);

        sendState(this.window, this.root, pane);
        return other.id;
    };

    close = (id: number) => {
        if (!this.root || !this.window) return;

        const listBefore: { id: number; rect: Rect }[] = (() => {
            const out: PaneState[] = [];
            const { w, h } = contentSize(this.window);

            if (this.root)
                layout(
                    this.window,
                    this.root,
                    { x: 0, y: 0, width: w, height: h },
                    out
                );

            return out.map((p) => ({ id: p.id, rect: p.rect }));
        })();

        const closedRect = listBefore.find((p) => p.id === id)?.rect;
        let nextActive: number | null = null;
        if (closedRect) {
            let best: { id: number; d2: number } | null = null;
            const cx = closedRect.x + closedRect.width / 2;
            const cy = closedRect.y + closedRect.height / 2;
            for (const p of listBefore) {
                if (p.id === id) continue;
                const px = p.rect.x + p.rect.width / 2;
                const py = p.rect.y + p.rect.height / 2;
                const dx = px - cx;
                const dy = py - cy;
                const d2 = dx * dx + dy * dy;
                if (!best || d2 < best.d2) best = { id: p.id, d2 };
            }
            nextActive = best?.id ?? null;
        }

        const pane = this.paneById.get(id);

        if (!pane) return;

        // Close the pane which removes all layers (overlay + content)
        pane.close();

        // Destroy the views
        for (const layer of pane.leaf.layers ?? []) {
            try {
                (layer as any)?.destroy?.();
            } catch { }
        }
        this.paneById.delete(id);
        this.searchStates.delete(id);
        this.overlayStates.delete(id);
        this.biscuitStates.delete(id);
        if (this.searchDebounceTimers.has(id)) {
            clearTimeout(this.searchDebounceTimers.get(id)!);
            this.searchDebounceTimers.delete(id);
        }

        if (this.root.kind === "leaf" && (this.root as any).id === id) {
            this.root = null;
            sendState(this.window, this.root, null);
            this.window.close();
            return;
        }
        this.root = replaceNode(this.root, id);
        sendState(this.window, this.root, null);

        if (nextActive != null && this.paneById.has(nextActive)) {
            this.lastActivePaneId = nextActive;
            this.focus(nextActive);
        }
    };

    getAll = (): { id: number; rect: Rect }[] => {
        const out: PaneState[] = [];
        if (this.root && this.window) {
            const { w, h } = contentSize(this.window);
            layout(this.window, this.root, { x: 0, y: 0, width: w, height: h }, out);
        }
        return out.map((p) => ({ id: p.id, rect: p.rect }));
    };

    getNeighbor = (
        currentId: number,
        dir: "left" | "right" | "up" | "down"
    ): number | null => {
        const panes = this.getAll();
        const cur = panes.find((p) => p.id === currentId);
        if (!cur) return null;

        const curLeft = cur.rect.x;
        const curRight = cur.rect.x + cur.rect.width;
        const curTop = cur.rect.y;
        const curBottom = cur.rect.y + cur.rect.height;
        const cx = (curLeft + curRight) / 2;
        const cy = (curTop + curBottom) / 2;

        const isHorizontal = dir === "left" || dir === "right";
        const correctSide = (dx: number, dy: number) =>
            dir === "left"
                ? dx < 0
                : dir === "right"
                    ? dx > 0
                    : dir === "up"
                        ? dy < 0
                        : dy > 0;

        const overlapsOrth = (r: Rect) => {
            const left = r.x;
            const right = r.x + r.width;
            const top = r.y;
            const bottom = r.y + r.height;
            if (isHorizontal) {
                return Math.max(curTop, top) < Math.min(curBottom, bottom);
            } else {
                return Math.max(curLeft, left) < Math.min(curRight, right);
            }
        };

        type Cand = { id: number; primary: number; secondary: number };
        const overlapCands: Cand[] = [];
        const fallbackCands: Cand[] = [];

        for (const p of panes) {
            if (p.id === currentId) continue;
            const px = p.rect.x + p.rect.width / 2;
            const py = p.rect.y + p.rect.height / 2;
            const dx = px - cx;
            const dy = py - cy;
            if (!correctSide(dx, dy)) continue;
            const primary = Math.abs(isHorizontal ? dx : dy);
            const secondary = Math.abs(isHorizontal ? dy : dx);
            const cand: Cand = { id: p.id, primary, secondary };
            if (overlapsOrth(p.rect)) overlapCands.push(cand);
            else fallbackCands.push(cand);
        }

        const pickByPrimaryThenSecondary = (list: Cand[]): number | null => {
            if (!list.length) return null;
            list.sort(
                (a, b) =>
                    a.primary - b.primary || a.secondary - b.secondary || a.id - b.id
            );
            return list[0].id;
        };

        const overlapPick = pickByPrimaryThenSecondary(overlapCands);
        if (overlapPick != null) return overlapPick;

        if (fallbackCands.length) {
            fallbackCands.sort((a, b) => {
                const angA = a.secondary / Math.max(1, a.primary);
                const angB = b.secondary / Math.max(1, b.primary);
                if (angA !== angB) return angA - angB;
                const distA = Math.hypot(a.primary, a.secondary);
                const distB = Math.hypot(b.primary, b.secondary);
                if (distA !== distB) return distA - distB;
                return a.id - b.id;
            });
            return fallbackCands[0].id;
        }

        return null;
    };

    handlePanesCreate = (_: unknown, payload: { url: string; rect: Rect }) =>
        this.create(payload.url || "https://perplexity.com");

    handlePanesList = () => {
        const out: PaneState[] = [];
        if (this.root) {
            const { w, h } = contentSize(this.window);
            layout(this.window, this.root, { x: 0, y: 0, width: w, height: h }, out);
        }
        return out;
    };

    handlePaneGet = (_: unknown, { id }: { id: number }) => {
        return this.paneById.get(id)?.leaf;
    };

    onPanesNavigate = (
        e: Electron.Event,
        { id, dir }: { id: number; dir: "left" | "right" | "up" | "down" }
    ) => {
        e.preventDefault();
        const start = this.lastActivePaneId ?? id;
        if (!this.paneById.has(start)) return;
        const next = this.getNeighbor(start, dir);
        if (next != null && this.paneById.has(next)) {
            this.lastActivePaneId = next;
            this.focus(next);
        }
    };

    handlePaneNavigate = (_: unknown, payload: { id: number; url: string }) => {
        this.paneById.get(payload.id)?.navigate(payload.url);
    };

    handlePaneActive = (_: unknown, { id }: { id: number }) => {
        if (!this.paneById.has(id)) return;
        this.lastActivePaneId = id;
    };

    handlePaneOverlay = (_: unknown, { id }: { id: number }) => {
        const pane = this.paneById.get(id);
        if (!pane) return;
        pane.reverse();
    };

    onPaneBiscuits = (
        _: unknown,
        { id }: { id: number }
    ) => {
        const targetId = this.lastActivePaneId ?? id;
        const pane = this.paneById.get(targetId);
        if (!pane) return;
        try {
            pane.leaf.view.webContents.send("pane:biscuits");
        } catch { }
    };

    onPaneScroll = (
        _: unknown,
        { id, deltaY }: { id: number; deltaY: number }
    ) => {
        const targetId = this.lastActivePaneId ?? id;
        const pane = this.paneById.get(targetId);
        if (!pane) return;
        try {
            pane.leaf.view.webContents.send("pane:scroll", { deltaY });
        } catch { }
    };

    onPaneClose = (_: unknown, { paneId }: { paneId: number }) => {
        this.close(paneId);

        if (!this.root) this.window?.close();
    };

    onPaneSplit = (
        event: Electron.Event,
        payload: {
            id: number;
            dir: "vertical" | "horizontal";
            side: "left" | "right" | "up" | "down";
        }
    ) => {
        event.preventDefault();
        const targetId = this.lastActivePaneId ?? payload.id;
        this.split(targetId, payload.dir, payload.side);
    };

    onPaneResize = (
        _: unknown,
        { id, dir }: { id: number; dir: "left" | "right" | "up" | "down" }
    ) => {
        const targetId = this.lastActivePaneId ?? id;
        nudgeSplitSize(this.window, this.root, targetId, dir);
    };

    subscribe = (pane: Pane) => {
        const leaf = pane.leaf;

        for (const view of leaf.layers ?? []) {
            const wc = view.webContents;

            const sync = async () => {
                if (leaf.view.webContents.getURL() !== view.webContents.getURL()) {
                    return;
                }

                const current = wc.getURL();
                if (!current.startsWith("data:")) {
                    leaf.url = current || leaf.url;
                }
                leaf.title = wc.getTitle();
                leaf.html = await pane.html();

                const backgroundColor = await pane.backgroundColor();
                const textColor = await pane.textColor();
                const description = await pane.description();
                const favicon = await pane.favicon();
                const image = await pane.image();

                leaf.backgroundColor = backgroundColor;
                leaf.textColor = textColor;
                leaf.description = description;
                leaf.favicon = favicon;
                leaf.image = image;

                // Update search state with current URL
                const searchState = this.searchStates.get(leaf.id);
                if (searchState) {
                    searchState.query = leaf.url;
                    this.broadcastSearchUpdate(leaf.id, leaf.url);
                }
                
                // Broadcast updated pane state to all overlays
                sendState(this.window, this.root, pane);
            };

            wc.on("did-navigate", sync);
            wc.on("did-navigate-in-page", sync);
            wc.on("page-title-updated", sync);
            wc.once("destroyed", () => {
                wc.removeListener("did-navigate", sync);
                wc.removeListener("did-navigate-in-page", sync);
                wc.removeListener("page-title-updated", sync);
            });
            
            // Intercept all new window attempts and navigate in the same pane
            wc.setWindowOpenHandler((details) => {
                // Navigate in the current pane instead of opening new window
                wc.loadURL(details.url);
                return { action: 'deny' };
            });
            
            // Also handle window.open() calls that might bypass the handler
            wc.on('new-window', (event, url) => {
                event.preventDefault();
                wc.loadURL(url);
            });

            wc.on(
                "did-fail-load",
                (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
                    if (!isMainFrame) return;
                    if (errorCode === -3) return;
                    const html = error(validatedURL, errorCode, errorDesc);
                    wc.loadURL(
                        `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
                        {
                            baseURLForDataURL: validatedURL || "about:blank",
                        }
                    );
                }
            );

            wc.on("before-input-event", (event, input) => {
                if (input.type !== "keyDown") return;

                const overlay = this.overlayStates.get(leaf.id) || false;
                const biscuitState = this.biscuitStates.get(leaf.id);
                const biscuitsActive = biscuitState?.active || false;

                // Handle biscuit mode input
                if (biscuitsActive && input.key) {
                    const key = input.key.toLowerCase();
                    
                    // Escape cancels biscuit mode
                    if (key === 'escape') {
                        biscuitState.active = false;
                        biscuitState.typed = "";
                        view.webContents.send("pane:biscuits:deactivate");
                        return;
                    }
                    
                    // Check if it's a valid hint character
                    const HINT_CHARS = 'asdfghjklqwertuiopzxcvbnm';
                    if (HINT_CHARS.includes(key) && !input.control && !input.meta && !input.alt) {
                        biscuitState.typed += key;
                        view.webContents.send("pane:biscuits:update", { typed: biscuitState.typed });
                        return;
                    }
                    
                    // Backspace removes last character
                    if (key === 'backspace' && biscuitState.typed.length > 0) {
                        biscuitState.typed = biscuitState.typed.slice(0, -1);
                        view.webContents.send("pane:biscuits:update", { typed: biscuitState.typed });
                        return;
                    }
                    
                    // Any other key cancels biscuit mode
                    biscuitState.active = false;
                    biscuitState.typed = "";
                    view.webContents.send("pane:biscuits:deactivate");
                    // Don't return here - let the key fall through to normal handling
                }

                const SCROLL_SIZE = 80;
                const STEP_SIZE = 4;

                const overlayKeys = {
                    "escape": () => {
                        // Unfocus any active element in the page
                        view.webContents.executeJavaScript(`
                            (() => {
                                const activeEl = document.activeElement;
                                if (activeEl && activeEl !== document.body) {
                                    activeEl.blur();
                                }
                                // Also clear any text selection
                                window.getSelection().removeAllRanges();
                            })()
                        `);
                    },
                    "control+v": () => {
                        const biscuitState = this.biscuitStates.get(leaf.id);
                        if (biscuitState && !biscuitState.active) {
                            // Don't activate biscuits if overlay is open
                            if (!overlay) {
                                biscuitState.active = true;
                                biscuitState.typed = "";
                                view.webContents.send("pane:biscuits:activate");
                            }
                        }
                    },
                    "g": () => view.webContents.scrollToTop(),
                    "j": () => view.webContents.send("pane:scroll", { deltaY: SCROLL_SIZE }),
                    "k": () => view.webContents.send("pane:scroll", { deltaY: -1 * SCROLL_SIZE }),
                    "shift+g": () => view.webContents.scrollToBottom(),
                    "shift+d": () => view.webContents.send("pane:scroll", { deltaY: SCROLL_SIZE * STEP_SIZE }),
                    "shift+u": () => view.webContents.send("pane:scroll", { deltaY: -1 * SCROLL_SIZE * STEP_SIZE }),
                    "control+h": () => this.onPanesNavigate(event, { id: leaf.id, dir: "left" }),
                    "control+l": () => this.onPanesNavigate(event, { id: leaf.id, dir: "right" }),
                    "control+k": () => this.onPanesNavigate(event, { id: leaf.id, dir: "up" }),
                    "control+j": () => this.onPanesNavigate(event, { id: leaf.id, dir: "down" }),
                }

                const paneKeys = {
                    "meta+l": () => {
                        event.preventDefault();
                        // Disable biscuits when opening overlay
                        if (biscuitsActive) {
                            biscuitState!.active = false;
                            biscuitState!.typed = "";
                            view.webContents.send("pane:biscuits:deactivate");
                        }
                        pane.reverse();
                        this.overlayStates.set(leaf.id, !overlay);
                    },
                    "meta+r": () => {
                        event.preventDefault();
                        view.webContents.reload();
                    },
                    "meta+shift+r": () => {
                        event.preventDefault();
                        view.webContents.reloadIgnoringCache();
                    },
                    "meta+[": () => {
                        event.preventDefault();
                        if (!overlay && view.webContents.canGoBack()) view.webContents.goBack();
                    },
                    "meta+]": () => {
                        event.preventDefault();
                        if (!overlay && view.webContents.canGoForward()) view.webContents.goForward();
                    },
                }

                const appKeys = {
                    "meta+w": () => {
                        event.preventDefault();
                        this.close(leaf.id);

                        if (!this.root) this.window?.close();
                    },
                    "shift+h": () => {
                        this.onPaneSplit(event, {
                            id: leaf.id,
                            dir: "vertical",
                            side: "left",
                        });
                    },
                    "shift+l": () => {
                        this.onPaneSplit(event, {
                            id: leaf.id,
                            dir: "vertical",
                            side: "right",
                        });
                    },
                    "shift+k": () => {
                        this.onPaneSplit(event, {
                            id: leaf.id,
                            dir: "horizontal",
                            side: "up",
                        });
                    },
                    "shift+j": () => {
                        this.onPaneSplit(event, {
                            id: leaf.id,
                            dir: "horizontal",
                            side: "down",
                        });
                    },
                    "meta+shift+h": () => {
                        this.onPaneResize(event, { id: leaf.id, dir: "left" });
                    },
                    "meta+shift+l": () => {
                        this.onPaneResize(event, { id: leaf.id, dir: "right" });
                    },
                    "meta+shift+k": () => {
                        this.onPaneResize(event, { id: leaf.id, dir: "up" });
                    },
                    "meta+shift+j": () => {
                        this.onPaneResize(event, { id: leaf.id, dir: "down" });
                    },
                }

                const keybinds = {
                    ...overlay === false ? overlayKeys : {},
                    ...paneKeys,
                    ...appKeys,
                };

                const buildKeybindString = (input: Electron.Input) => {
                    const modifiers: string[] = [];
                    if (input.meta) modifiers.push("meta");
                    if (input.shift) modifiers.push("shift");
                    if (input.alt) modifiers.push("alt");
                    if (input.control) modifiers.push("control");

                    const key = input.key?.toLowerCase();
                    return modifiers.length > 0 ? `${modifiers.join("+")}+${key}` : key;
                };

                const keybindString = buildKeybindString(input);
                const keybind = keybinds[keybindString];
                if (keybind) {
                    event.preventDefault();
                    keybind();
                    sendState(this.window, this.root, pane);
                }

                return;
            });
        }
    };

    handleSearchInput = async (_: Electron.IpcMainInvokeEvent, { paneId, query }: { paneId: number; query: string }) => {
        const searchState: SearchState = {
            query,
            paneId,
            isFocused: true
        };
        this.searchStates.set(paneId, searchState);

        if (this.searchDebounceTimers.has(paneId)) {
            clearTimeout(this.searchDebounceTimers.get(paneId)!);
        }

        this.broadcastSearchUpdate(paneId, query);

        const timer = setTimeout(() => {
            this.processSearchDebounced(paneId, query);
        }, 450);
        this.searchDebounceTimers.set(paneId, timer);
    };

    handleSearchSubmit = async (_: Electron.IpcMainInvokeEvent, { paneId, query }: { paneId: number; query: string }) => {
        if (this.searchDebounceTimers.has(paneId)) {
            clearTimeout(this.searchDebounceTimers.get(paneId)!);
            this.searchDebounceTimers.delete(paneId);
        }

        const trimmedQuery = query.trim();
        if (!trimmedQuery) return;

        let url: string;
        if (isLikelyUrl(trimmedQuery)) {
            url = normalizeUrlSmart(trimmedQuery);
        } else {
            url = buildGoogleSearchUrl(trimmedQuery);
        }

        const pane = this.paneById.get(paneId);
        if (pane) {
            pane.leaf.view.webContents.loadURL(url);
            this.broadcastSearchUpdate(paneId, url);
            
            // Close the overlay after navigation
            pane.reverse();
            this.overlayStates.set(paneId, false);
        }

        const searchState = this.searchStates.get(paneId);
        if (searchState) {
            searchState.isFocused = false;
            this.broadcastSearchFocus(paneId, false);
        }
    };

    handleSearchBlur = async (_: Electron.IpcMainInvokeEvent, { paneId }: { paneId: number }) => {
        const searchState = this.searchStates.get(paneId);
        if (searchState) {
            searchState.isFocused = false;
            this.broadcastSearchFocus(paneId, false);
        }
    };

    private processSearchDebounced = (paneId: number, query: string) => {
        const trimmedQuery = query.trim();
        if (!trimmedQuery || /\s/.test(trimmedQuery)) return;

        if (isLikelyUrl(trimmedQuery)) {
            const url = normalizeUrlSmart(trimmedQuery);
            const pane = this.paneById.get(paneId);
            if (pane) {
                pane.leaf.view.webContents.loadURL(url);
            }
        }
    };

    private broadcastSearchUpdate = (paneId: number, query: string) => {
        this.paneById.forEach(pane => {
            pane.leaf.layers?.forEach(layer => {
                layer.webContents.send("search:update", { paneId, query });
            });
        });
    };

    private broadcastSearchFocus = (paneId: number, isFocused: boolean) => {
        this.paneById.forEach(pane => {
            pane.leaf.layers?.forEach(layer => {
                layer.webContents.send("search:focus", { paneId, isFocused });
            });
        });
    };

    onBiscuitsCompleted = (_: Electron.IpcMainEvent, data: any) => {
        // Find the pane ID from the webContents that sent this event
        let paneId: number | null = null;
        this.paneById.forEach((pane, id) => {
            if (pane.leaf.view.webContents === _.sender) {
                paneId = id;
            }
        });
        
        if (paneId !== null) {
            const biscuitState = this.biscuitStates.get(paneId);
            if (biscuitState) {
                biscuitState.active = false;
                biscuitState.typed = "";
            }
        }
    };
}
