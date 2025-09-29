import { BaseWindow, ipcMain, Menu, WebContentsView, app } from "electron";

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
    typingStates = new Map<number, boolean>(); // Track if user is typing in an input

    window: BaseWindow;
    root: Node | null = null;

    constructor() {
        Menu.setApplicationMenu(null);
        
        const iconPath = process.platform === 'darwin' 
            ? path.join(app.getAppPath(), 'assets', 'icon.icns')
            : process.platform === 'win32'
            ? path.join(app.getAppPath(), 'assets', 'icon.ico')
            : path.join(app.getAppPath(), 'assets', 'icon.png');
        
        this.window = new BaseWindow({
            width: 1200,
            height: 800,
            frame: false,
            titleBarStyle: "hidden",
            backgroundColor: "#00000000",
            icon: iconPath,
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
        await this.create("https://staging.onplug.io");

        ipcMain.handle("panes:create", this.handlePanesCreate);
        ipcMain.handle("panes:list", this.handlePanesList);
        ipcMain.handle("pane:get", this.handlePaneGet);
        ipcMain.handle("pane:overlay", this.handlePaneOverlay);
        ipcMain.handle("pane:navigate", this.handlePaneNavigate);
        ipcMain.handle("pane:active", this.handlePaneActive);
        ipcMain.handle("search:input", this.handleSearchInput);
        ipcMain.handle("search:submit", this.handleSearchSubmit);
        ipcMain.handle("search:blur", this.handleSearchBlur);
        ipcMain.handle("pane:typing:update", this.handleTypingUpdate);

        ipcMain.on("panes:navigate", this.onPanesNavigate);
        ipcMain.on("pane:biscuits", this.onPaneBiscuits);
        ipcMain.on("pane:scroll", this.onPaneScroll);
        ipcMain.on("pane:close", this.onPaneClose);
        ipcMain.on("pane:split", this.onPaneSplit);
        ipcMain.on("pane:resize", this.onPaneResize);
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
        this.typingStates.set(id, false);

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
        const pane = await this.make(url || "https://chat.com");
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
        this.create(payload.url || "https://chat.com");

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

            // Handle biscuits completion from webview
            wc.on('ipc-message', (event, channel) => {
                if (channel === 'pane:biscuits:completed') {
                    const biscuitState = this.biscuitStates.get(leaf.id);
                    if (biscuitState) {
                        biscuitState.active = false;
                        biscuitState.typed = "";
                    }
                    // Make sure to send deactivate to clean up any remaining state
                    try {
                        leaf.view.webContents.send("pane:biscuits:deactivate");
                    } catch { }
                }
            });

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

            const handleNavigation = () => {
                // Clear biscuit state on navigation
                const biscuitState = this.biscuitStates.get(leaf.id);
                if (biscuitState) {
                    biscuitState.active = false;
                    biscuitState.typed = "";
                }
                // Clear typing state on navigation
                this.typingStates.set(leaf.id, false);
                sync();
            };


            wc.on("did-navigate", handleNavigation);
            wc.on("did-navigate-in-page", handleNavigation);
            wc.on("page-title-updated", sync);
            wc.once("destroyed", () => {
                wc.removeListener("did-navigate", handleNavigation);
                wc.removeListener("did-navigate-in-page", handleNavigation);
                wc.removeListener("page-title-updated", sync);
            });

            // Intercept all new window attempts and navigate in the same pane
            wc.setWindowOpenHandler((details) => {
                // Navigate in the current pane instead of opening new window
                wc.loadURL(details.url);
                return { action: 'deny' };
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
                const isTyping = this.typingStates.get(leaf.id) || false;

                // Check if user is typing in an input field
                const checkTypingContext = () => {
                    return wc.executeJavaScript(`
                        (() => {
                            function deepestActiveElement(root) {
                                let ae = root.activeElement;
                                while (ae && ae.shadowRoot && ae.shadowRoot.activeElement) {
                                    ae = ae.shadowRoot.activeElement;
                                }
                                return ae;
                            }
                            
                            const el = deepestActiveElement(document);
                            if (!el) return false;
                            
                            if (el.isContentEditable) return true;
                            const ce = el.getAttribute?.('contenteditable');
                            if (ce === '' || ce === 'true') return true;
                            
                            const tag = el.tagName?.toLowerCase();
                            if (tag === 'textarea') return true;
                            
                            if (tag === 'input') {
                                const t = el.type?.toLowerCase();
                                if (!t) return true;
                                if (['text', 'search', 'url', 'email', 'password', 'tel', 'number', 'date', 'datetime-local', 'month', 'time', 'week'].includes(t)) return true;
                            }
                            
                            if (el.getAttribute?.('role') === 'textbox') return true;
                            return false;
                        })()
                    `);
                };

                if (biscuitState !== undefined && biscuitsActive && input.key) {
                    const key = input.key.toLowerCase();

                    // Escape cancels biscuit mode
                    if (key === 'escape') {
                        event.preventDefault();
                        biscuitState.active = false;
                        biscuitState.typed = "";
                        leaf.view.webContents.send("pane:biscuits:deactivate");
                        return;
                    }

                    // Check if it's a valid hint character
                    const HINT_CHARS = 'asdghjklqwertuiopzxcvbnm'; // 'f' removed since it toggles biscuits
                    if (HINT_CHARS.includes(key) && !input.control && !input.meta && !input.alt) {
                        event.preventDefault();
                        biscuitState.typed += key;
                        leaf.view.webContents.send("pane:biscuits:update", { typed: biscuitState.typed });
                        return;
                    }

                    // Backspace removes last character
                    if (key === 'backspace' && biscuitState.typed.length > 0) {
                        event.preventDefault();
                        biscuitState.typed = biscuitState.typed.slice(0, -1);
                        leaf.view.webContents.send("pane:biscuits:update", { typed: biscuitState.typed });
                        return;
                    }

                    // For any other alphanumeric key, prevent default to stop page shortcuts
                    if (key.length === 1 && !input.control && !input.meta && !input.alt) {
                        event.preventDefault();
                        // Cancel biscuit mode for non-hint characters
                        biscuitState.active = false;
                        biscuitState.typed = "";
                        leaf.view.webContents.send("pane:biscuits:deactivate");
                    }

                    return;
                }

                // Build the keybind string
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

                const SCROLL_SIZE = 80;
                const STEP_SIZE = 4;

                const overlayKeys = {
                    "f": () => {
                        const biscuitState = this.biscuitStates.get(leaf.id);
                        if (biscuitState) {
                            // Toggle biscuits (but don't activate if overlay is open)
                            if (biscuitState.active) {
                                biscuitState.active = false;
                                biscuitState.typed = "";
                                leaf.view.webContents.send("pane:biscuits:deactivate");
                            } else if (!overlay) {
                                biscuitState.active = true;
                                biscuitState.typed = "";
                                leaf.view.webContents.send("pane:biscuits:activate");
                            }
                        }
                    },
                    "g": () => leaf.view.webContents.send("pane:scrollToTop"),
                    "j": () => leaf.view.webContents.send("pane:scroll", { deltaY: SCROLL_SIZE }),
                    "k": () => leaf.view.webContents.send("pane:scroll", { deltaY: -1 * SCROLL_SIZE }),
                    "shift+g": () => leaf.view.webContents.send("pane:scrollToBottom"),
                    "shift+d": () => leaf.view.webContents.send("pane:scroll", { deltaY: SCROLL_SIZE * STEP_SIZE }),
                    "shift+u": () => leaf.view.webContents.send("pane:scroll", { deltaY: -1 * SCROLL_SIZE * STEP_SIZE }),
                    "control+h": () => this.onPanesNavigate(event, { id: leaf.id, dir: "left" }),
                    "control+l": () => this.onPanesNavigate(event, { id: leaf.id, dir: "right" }),
                    "control+k": () => this.onPanesNavigate(event, { id: leaf.id, dir: "up" }),
                    "control+j": () => this.onPanesNavigate(event, { id: leaf.id, dir: "down" }),
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
                }

                const paneKeys = {
                    "meta+l": () => {
                        event.preventDefault();
                        // Disable biscuits when opening overlay
                        if (biscuitsActive) {
                            biscuitState!.active = false;
                            biscuitState!.typed = "";
                            leaf.view.webContents.send("pane:biscuits:deactivate");
                        }
                        pane.reverse();
                        this.overlayStates.set(leaf.id, !overlay);
                    },
                    "meta+r": () => {
                        event.preventDefault();
                        leaf.view.webContents.reload();
                    },
                    "meta+shift+r": () => {
                        event.preventDefault();
                        leaf.view.webContents.reloadIgnoringCache();
                    },
                    "meta+[": () => {
                        event.preventDefault();
                        if (!overlay && leaf.view.webContents.canGoBack()) leaf.view.webContents.goBack();
                    },
                    "meta+]": () => {
                        event.preventDefault();
                        if (!overlay && leaf.view.webContents.canGoForward()) leaf.view.webContents.goForward();
                    },
                }

                const appKeys = {
                    "meta+w": () => {
                        event.preventDefault();
                        this.close(leaf.id);

                        if (!this.root) this.window?.close();
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

                // Special handling for Escape key
                if (input.key?.toLowerCase() === 'escape' && !overlay) {
                    // Only handle escape when typing OR biscuits active
                    if (biscuitsActive) {
                        // Already handled in biscuit mode section above
                        return;
                    }

                    if (isTyping) {
                        event.preventDefault();
                        // Unfocus any active element
                        leaf.view.webContents.executeJavaScript(`
                            (() => {
                                const activeEl = document.activeElement;
                                if (activeEl && activeEl !== document.body) {
                                    activeEl.blur();
                                }
                                window.getSelection().removeAllRanges();
                            })()
                        `);
                    }
                    // If not typing, let escape through for website use
                    return;
                }

                // Check all available keybinds first
                const allKeybinds = {
                    ...(overlay === false && !biscuitsActive) ? overlayKeys : {},
                    ...paneKeys,
                    ...appKeys,
                };

                // If we have a keybind for this key combo, check if we need to verify typing context
                const keybind = allKeybinds[keybindString];
                if (keybind) {
                    // For modifier-less keys, check typing context
                    const isTypingKey = !input.meta && !input.control && !input.alt;

                    if (isTypingKey && !overlay && !biscuitsActive) {
                        // For single keys, check if user is typing
                        if (!isTyping) {
                            event.preventDefault();
                            keybind();
                            sendState(this.window, this.root, pane);
                        }
                        // If typing, let the key through to the page
                    } else {
                        // Keys with modifiers can be handled immediately
                        event.preventDefault();
                        keybind();
                        sendState(this.window, this.root, pane);
                    }
                    return;
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
            // Use JavaScript navigation to preserve history
            pane.leaf.view.webContents.executeJavaScript(`window.location.assign('${url.replace(/'/g, "\\'")}')`);
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

    handleTypingUpdate = async (_: Electron.IpcMainInvokeEvent, { paneId, isTyping }: { paneId: number; isTyping: boolean }) => {
        this.typingStates.set(paneId, isTyping);
    };

    private processSearchDebounced = (paneId: number, query: string) => {
        const trimmedQuery = query.trim();
        if (!trimmedQuery || /\s/.test(trimmedQuery)) return;

        if (isLikelyUrl(trimmedQuery)) {
            const url = normalizeUrlSmart(trimmedQuery);
            const pane = this.paneById.get(paneId);
            if (pane) {
                // Use JavaScript navigation to preserve history
                pane.leaf.view.webContents.executeJavaScript(`window.location.assign('${url.replace(/'/g, "\\'")}')`);
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

}
