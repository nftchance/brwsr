import { BaseWindow, ipcMain, Menu, WebContentsView, app } from "electron";

import { Leaf, Split, Node, Rect, PaneState, SearchState } from "../pane/types";
import { savePaneState, loadPaneState, serializeNode, SerializedNode } from "../storage/paneState";
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
import { setupAutoUpdater, checkForUpdates } from "../updater";
import { WorkspaceManager } from "../workspace/manager";

import * as path from "path";

export class Window {
    window: BaseWindow;
    root: Node | null = null;
    workspaceManager: WorkspaceManager;
    activeNodeId: string | null = null;

    panesById = new Map<string, Pane>();
    paneById = new Map<number, Pane>();
    lastActivePaneId: number | null = null;

    searchStates = new Map<number, SearchState>();
    searchDebounceTimers = new Map<number, NodeJS.Timeout>();
    overlayStates = new Map<number, boolean>();
    biscuitStates = new Map<number, { active: boolean; typed: string }>();
    typingStates = new Map<number, boolean>();

    saveDebounceTimer: NodeJS.Timeout | null = null;

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
            // Clean up without trying to access destroyed views
            this.paneById.clear();
            this.searchStates.clear();
            this.overlayStates.clear();
            this.biscuitStates.clear();
            this.typingStates.clear();
            if (this.saveDebounceTimer) {
                clearTimeout(this.saveDebounceTimer);
            }
        });

        try {
            if (process.platform === "darwin")
                this.window.setWindowButtonVisibility(false);
        } catch { }

        this.window.on("resize", () => {
            sendState(this.window, this.root);
            this.debouncedSave();
        });

        // Save state before window closes, but only if we have panes
        this.window.on("close", () => {
            if (this.root) {
                // Clear any pending saves and save immediately
                if (this.saveDebounceTimer) {
                    clearTimeout(this.saveDebounceTimer);
                    this.saveDebounceTimer = null;
                }
                this.saveState();
            }
        });
    }

    init = async () => {
        // Register handlers first before creating any panes
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
        ipcMain.on("pane:biscuits:completed", this.onBiscuitsCompleted);

        // Register workspace handlers first (before creating workspace manager)
        ipcMain.handle("workspace:list", this.handleWorkspaceList);
        ipcMain.handle("workspace:switch", this.handleWorkspaceSwitch);
        ipcMain.handle("workspace:create", this.handleWorkspaceCreate);

        // Set up auto-updater
        setupAutoUpdater(this.window);
        // Check for updates 30 seconds after startup (disabled in dev)
        // setTimeout(() => checkForUpdates(), 30000);

        // Load saved state or create default
        const savedState = loadPaneState();
        
        // Initialize workspace manager first
        this.workspaceManager = new WorkspaceManager(this);
        
        // Load workspace state if available
        if (savedState?.workspaceState) {
            this.workspaceManager.loadState(savedState.workspaceState);
        }

        if (savedState && savedState.root) {
            // Restore saved pane layout
            await this.restoreFromSavedState(savedState.root);

            // Only set lastActivePaneId if it exists in the restored panes
            if (savedState.lastActivePaneId && this.paneById.has(savedState.lastActivePaneId)) {
                this.lastActivePaneId = savedState.lastActivePaneId;
            } else {
                // Default to first pane if saved active pane doesn't exist
                this.lastActivePaneId = this.paneById.keys().next().value || null;
            }

            // Restore window bounds if available
            if (savedState.windowBounds) {
                this.window.setBounds(savedState.windowBounds);
            }
        } else {
            // First time user - create default pane
            await this.create("https://staging.onplug.io");
        }
        
        // Initialize default workspace (will use loaded state if available)
        this.workspaceManager.initializeDefaultWorkspace();
    };

    create = async (url: string) => {
        if (!this.root) {
            const pane = await this.make(url);

            this.root = pane.leaf;
            this.lastActivePaneId = pane.id;

            sendState(this.window, this.root);
            this.debouncedSave();

            return pane.id;
        }

        const last = Array.from(this.paneById.values()).slice(-1)[0];
        return this.split(last.id, "vertical", "right", url);
    };

    make = async (url: string, providedId?: number): Promise<Pane> => {
        if (!this.window) throw new Error("No window to attach pane to");

        const id = providedId || allocId();

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
        // Don't save if we just cleared the root
        if (this.root) {
            this.debouncedSave();
        }
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
            // Last pane in workspace is being closed
            const currentWorkspace = this.workspaceManager?.getActiveWorkspace();
            if (currentWorkspace && this.workspaceManager) {
                const allWorkspaces = this.workspaceManager.getWorkspaces();
                
                // If this is the only workspace, close the window
                if (allWorkspaces.length <= 1) {
                    this.root = null;
                    sendState(this.window, this.root, null);
                    this.window.close();
                    return;
                }
                
                // Remove the current workspace and switch to another
                this.workspaceManager.removeWorkspace(currentWorkspace.id);
                
                // Find another workspace to switch to
                const remainingWorkspaces = this.workspaceManager.getWorkspaces();
                if (remainingWorkspaces.length > 0) {
                    // Switch to the first available workspace
                    this.workspaceManager.switchToWorkspace(remainingWorkspaces[0].id);
                }
            } else {
                // No workspace manager, close the window
                this.root = null;
                sendState(this.window, this.root, null);
                this.window.close();
            }
            return;
        }
        this.root = replaceNode(this.root, id);
        sendState(this.window, this.root, null);

        // Only save if we still have panes
        if (this.root) {
            this.debouncedSave();
        }

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
            this.debouncedSave();
        }
    };

    handlePaneNavigate = (_: unknown, payload: { id: number; url: string }) => {
        this.paneById.get(payload.id)?.navigate(payload.url);
    };

    handlePaneActive = (_: unknown, { id }: { id: number }) => {
        if (!this.paneById.has(id)) return;
        this.lastActivePaneId = id;
        this.debouncedSave();
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
        this.debouncedSave();
    };

    onBiscuitsCompleted = (
        _: unknown,
        { paneId }: { paneId: number }
    ) => {
        const biscuitState = this.biscuitStates.get(paneId);
        if (biscuitState) {
            biscuitState.active = false;
            biscuitState.typed = "";
        }
        // Make sure to send deactivate to clean up any remaining state
        const pane = this.paneById.get(paneId);
        if (pane) {
            try {
                pane.leaf.view.webContents.send("pane:biscuits:deactivate");
            } catch { }
        }
    };

    subscribe = (pane: Pane) => {
        const leaf = pane.leaf;

        // Only listen to navigation events on the main view, not the overlay
        const mainView = leaf.view;
        const mainWc = mainView.webContents;
        
        // But we still need to setup the overlay communication
        for (const view of leaf.layers ?? []) {
            const wc = view.webContents;

            const sync = async () => {
                console.log(`[SYNC] Starting sync for pane ${leaf.id}`);
                // Always use the main view's URL and metadata, not the overlay's
                const mainWc = leaf.view.webContents;
                
                const current = mainWc.getURL();
                console.log(`[SYNC] Current URL: ${current}, Previous URL: ${leaf.url}`);
                
                const urlChanged = current !== leaf.url && !current.startsWith("data:");
                
                if (!current.startsWith("data:")) {
                    leaf.url = current || leaf.url;
                }
                leaf.title = mainWc.getTitle();
                leaf.html = await pane.html();

                // For SPAs that don't update meta tags, fetch fresh metadata if URL changed
                if (urlChanged && current.startsWith("http")) {
                    console.log(`[SYNC] URL changed, fetching fresh metadata from ${current}`);
                    try {
                        const response = await fetch(current);
                        const html = await response.text();
                        
                        // Parse the HTML to extract og:image
                        const imageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i) ||
                                          html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i);
                        if (imageMatch) {
                            leaf.image = imageMatch[1];
                            console.log(`[SYNC] Extracted image from fetched HTML: ${leaf.image}`);
                        }
                        
                        // Also get description
                        const descMatch = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
                                         html.match(/<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i);
                        if (descMatch) {
                            leaf.description = descMatch[1];
                        }
                    } catch (error) {
                        console.error(`[SYNC] Failed to fetch metadata:`, error);
                        // Fall back to DOM extraction
                        const image = await pane.image();
                        const description = await pane.description();
                        leaf.image = image;
                        leaf.description = description;
                    }
                    
                    // Also update visual properties on URL change
                    const backgroundColor = await pane.backgroundColor();
                    const textColor = await pane.textColor();
                    const favicon = await pane.favicon();
                    
                    leaf.backgroundColor = backgroundColor;
                    leaf.textColor = textColor;
                    leaf.favicon = favicon;
                    
                    console.log(`[SYNC] Pane ${leaf.id} - Title: ${leaf.title}, Image: ${leaf.image}`);
                }

                // Update search state with current URL
                const searchState = this.searchStates.get(leaf.id);
                if (searchState) {
                    searchState.query = leaf.url;
                    this.broadcastSearchUpdate(leaf.id, leaf.url);
                }

                // Broadcast updated pane state to ALL overlays, not just this pane's
                console.log(`[SYNC] Broadcasting state for pane ${leaf.id}`);
                const out: PaneState[] = [];
                if (this.root) {
                    const { w, h } = contentSize(this.window);
                    layout(this.window, this.root, { x: 0, y: 0, width: w, height: h }, out);
                }
                console.log(`[SYNC] Sending update to ${this.paneById.size} panes with data:`, out.map(p => ({ id: p.id, url: p.url, image: p.image })));
                
                // Send to all pane overlays
                let overlayCount = 0;
                this.paneById.forEach(p => {
                    for (const layer of p.leaf.layers ?? []) {
                        if (!layer.webContents.isDestroyed()) {
                            layer.webContents.send("panes:update", out);
                            overlayCount++;
                        }
                    }
                });
                console.log(`[SYNC] Sent updates to ${overlayCount} overlay layers`);
            };

            const handleNavigation = () => {
                console.log(`[NAV] Navigation detected for pane ${leaf.id}`);
                // Clear biscuit state on navigation
                const biscuitState = this.biscuitStates.get(leaf.id);
                if (biscuitState) {
                    biscuitState.active = false;
                    biscuitState.typed = "";
                }
                // Clear typing state on navigation
                this.typingStates.set(leaf.id, false);
                sync();
                
                // Save state after navigation
                this.debouncedSave();
                
                // Update workspace preview after navigation
                if (this.workspaceManager) {
                    this.workspaceManager.updateActiveWorkspacePreview(2000);
                }
            };


            // Only register navigation listeners for the main view
            if (view === mainView) {
                const handleTitleUpdate = () => {
                    console.log(`[TITLE] Title updated for pane ${leaf.id}`);
                    sync();
                    this.debouncedSave();
                };
                
                const handleDomReady = () => {
                    sync();
                };
                
                wc.on("did-navigate", handleNavigation);
                wc.on("did-navigate-in-page", handleNavigation);
                wc.on("did-frame-navigate", handleNavigation);
                wc.on("page-title-updated", handleTitleUpdate);
                wc.on("dom-ready", handleDomReady);
                
                wc.once("destroyed", () => {
                    wc.removeListener("did-navigate", handleNavigation);
                    wc.removeListener("did-navigate-in-page", handleNavigation);
                    wc.removeListener("did-frame-navigate", handleNavigation);
                    wc.removeListener("page-title-updated", handleTitleUpdate);
                    wc.removeListener("dom-ready", handleDomReady);
                });
            }

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
                    "m": () => this.workspaceManager?.toggleMute(),
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
                        if (biscuitsActive) {
                            biscuitState!.active = false;
                            biscuitState!.typed = "";
                            leaf.view.webContents.send("pane:biscuits:deactivate");
                        }
                        const wasOverlayOpen = overlay;
                        
                        // If opening overlay, sync state first to ensure latest data
                        if (!wasOverlayOpen) {
                            console.log(`[CMD+L] Opening overlay, syncing state first`);
                            sync();
                        }
                        
                        pane.reverse();
                        this.overlayStates.set(leaf.id, !overlay);
                        
                        // Broadcast search focus state
                        this.broadcastSearchFocus(leaf.id, !wasOverlayOpen);
                        
                        // Capture preview when closing overlay
                        if (wasOverlayOpen && this.workspaceManager) {
                            const activeWorkspace = this.workspaceManager.getActiveWorkspace();
                            if (activeWorkspace) {
                                setTimeout(() => {
                                    this.workspaceManager.captureWorkspacePreview(activeWorkspace.id);
                                }, 100);
                            }
                        }
                    },
                    "meta+1": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(0);
                    },
                    "meta+2": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(1);
                    },
                    "meta+3": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(2);
                    },
                    "meta+4": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(3);
                    },
                    "meta+5": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(4);
                    },
                    "meta+6": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(5);
                    },
                    "meta+7": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(6);
                    },
                    "meta+8": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(7);
                    },
                    "meta+9": () => {
                        event.preventDefault();
                        this.workspaceManager.switchToWorkspaceByIndex(8);
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

                if (input.key?.toLowerCase() === 'escape' && !overlay) {
                    if (biscuitsActive) {
                        return;
                    }

                    if (isTyping) {
                        event.preventDefault();
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
                    return;
                }

                const allKeybinds = {
                    ...(overlay === false && !biscuitsActive) ? overlayKeys : {},
                    ...paneKeys,
                    ...appKeys,
                };

                const keybind = allKeybinds[keybindString];
                if (keybind) {
                    const isTypingKey = !input.meta && !input.control && !input.alt;

                    if (isTypingKey && !overlay && !biscuitsActive) {
                        if (isTyping === true) return

                        event.preventDefault();
                        keybind();
                        sendState(this.window, this.root, pane);
                    } else {
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
            pane.leaf.view.webContents.executeJavaScript(`window.location.assign('${url.replace(/'/g, "\\'")}')`);
            this.broadcastSearchUpdate(paneId, url);

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

    private saveState = () => {
        // Only save if we have actual panes
        if (!this.root) return;

        const bounds = this.window.getBounds();
        savePaneState({
            root: serializeNode(this.root),
            lastActivePaneId: this.lastActivePaneId,
            windowBounds: bounds,
            workspaceState: this.workspaceManager ? this.workspaceManager.getState() : undefined
        });
    };

    debouncedSave = () => {
        if (this.saveDebounceTimer) {
            clearTimeout(this.saveDebounceTimer);
        }
        this.saveDebounceTimer = setTimeout(() => {
            this.saveState();
        }, 1000);
    };

    private restoreFromSavedState = async (savedRoot: SerializedNode) => {
        // Restore the node structure by creating panes
        this.root = await this.restoreNode(savedRoot);
        sendState(this.window, this.root);
    };
    
    // Workspace handlers
    handleWorkspaceList = async () => {
        if (!this.workspaceManager) {
            return [];
        }
        return this.workspaceManager.getWorkspaces().map(workspace => ({
            id: workspace.id,
            name: workspace.name,
            index: workspace.index,
            preview: workspace.preview,
            lastAccessed: workspace.lastAccessed,
            isActive: workspace.isActive,
        }));
    };
    
    handleWorkspaceSwitch = async (_: unknown, { workspaceId }: { workspaceId: string }) => {
        if (!this.workspaceManager) {
            return false;
        }
        return this.workspaceManager.switchToWorkspace(workspaceId);
    };
    
    handleWorkspaceCreate = async (_: unknown, { index }: { index?: number }) => {
        if (!this.workspaceManager) {
            return null;
        }
        const workspace = await this.workspaceManager.createWorkspace(index);
        if (!workspace) return null;
        
        return {
            id: workspace.id,
            name: workspace.name,
            index: workspace.index,
            preview: workspace.preview,
            lastAccessed: workspace.lastAccessed,
            isActive: workspace.isActive,
        };
    };

    restoreNode = async (node: SerializedNode): Promise<Node> => {
        if (node.kind === "leaf") {
            // Create pane with the correct ID from the start
            const pane = await this.make(node.url, node.id);

            // Update saved metadata
            if (node.title) pane.leaf.title = node.title;
            if (node.favicon) pane.leaf.favicon = node.favicon;
            if (node.description) pane.leaf.description = node.description;
            if (node.backgroundColor) pane.leaf.backgroundColor = node.backgroundColor;
            if (node.textColor) pane.leaf.textColor = node.textColor;
            if (node.image) pane.leaf.image = node.image;

            return pane.leaf;
        } else {
            const a = await this.restoreNode(node.a);
            const b = await this.restoreNode(node.b);
            const split: Split = {
                kind: "split",
                dir: node.dir,
                size: node.size,
                a,
                b
            };

            return split;
        }
    };

}
