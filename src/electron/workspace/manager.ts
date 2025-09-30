import { v4 as uuid } from "uuid";
import { desktopCapturer } from "electron";
import { Workspace, WorkspaceState } from "./types";
import { Node, Leaf, Split } from "../pane/types";
import { Window } from "../window";
import { serializeNode } from "../storage/paneState";

export class WorkspaceManager {
    private workspaces: Map<string, Workspace> = new Map();
    private activeWorkspaceId: string;
    private window: Window;
    private maxWorkspaces = 9;
    private previewUpdateInterval: NodeJS.Timeout | null = null;

    constructor(window: Window) {
        this.window = window;
        this.startPreviewUpdates();
    }
    
    private startPreviewUpdates() {
        // Update active workspace preview every second (unless overlay is open)
        this.previewUpdateInterval = setInterval(() => {
            const activeWorkspace = this.getActiveWorkspace();
            if (activeWorkspace && activeWorkspace.isActive) {
                // Check if any pane has overlay open
                let overlayOpen = false;
                this.window.overlayStates.forEach((isOpen) => {
                    if (isOpen) overlayOpen = true;
                });
                
                // Only update preview if overlay is closed
                if (!overlayOpen) {
                    this.captureWorkspacePreview(activeWorkspace.id);
                }
            }
            
            // Always check audible state for all workspaces and broadcast if changed
            this.broadcastWorkspaceUpdate();
        }, 1000); // 1 second
    }
    
    destroy() {
        if (this.previewUpdateInterval) {
            clearInterval(this.previewUpdateInterval);
            this.previewUpdateInterval = null;
        }
    }
    
    // Call this when significant navigation or content changes happen
    updateActiveWorkspacePreview(delay: number = 1000) {
        const activeWorkspace = this.getActiveWorkspace();
        if (activeWorkspace && activeWorkspace.isActive) {
            setTimeout(() => {
                // Check if any pane has overlay open
                let overlayOpen = false;
                this.window.overlayStates.forEach((isOpen) => {
                    if (isOpen) overlayOpen = true;
                });
                
                // Only update preview if overlay is closed
                if (!overlayOpen) {
                    this.captureWorkspacePreview(activeWorkspace.id);
                }
            }, delay);
        }
    }
    
    // Tree traversal helpers
    private forEachLeaf(node: Node, callback: (leaf: Leaf) => void): void {
        if (node.kind === "leaf") {
            callback(node);
        } else {
            this.forEachLeaf(node.a, callback);
            this.forEachLeaf(node.b, callback);
        }
    }
    
    private findActiveLeaf(node: Node): Leaf | null {
        if (node.kind === "leaf") {
            return node;
        }
        // In a split, find the first leaf
        const leftLeaf = this.findActiveLeaf(node.a);
        return leftLeaf || this.findActiveLeaf(node.b);
    }

    initializeDefaultWorkspace() {
        if (!this.window.root) return;
        
        // Check if we already have workspaces (from loaded state)
        if (this.workspaces.size > 0) {
            // Find the active workspace from loaded state
            const activeWorkspace = this.getActiveWorkspace();
            if (activeWorkspace) {
                // The window.root was already restored from serializedRoot in the main window init
                // Just use it as-is since it has the correct URLs
                activeWorkspace.root = this.window.root;
                activeWorkspace.serializedRoot = null;
                const activeLeaf = this.findActiveLeaf(this.window.root);
                activeWorkspace.activeNodeId = activeLeaf?.id || 0;
                activeWorkspace.lastActivePaneId = this.window.lastActivePaneId;
            }
            return;
        }
        
        // Create default workspace only if none exist
        const activeLeaf = this.findActiveLeaf(this.window.root);
        const defaultWorkspace: Workspace = {
            id: uuid(),
            name: "Workspace 1",
            index: 0,
            root: this.window.root,
            serializedRoot: null,
            activeNodeId: activeLeaf?.id || 0,
            lastActivePaneId: this.window.lastActivePaneId,
            lastAccessed: Date.now(),
            isActive: true,
        };

        this.workspaces.set(defaultWorkspace.id, defaultWorkspace);
        this.activeWorkspaceId = defaultWorkspace.id;
    }

    getWorkspaces(): Workspace[] {
        return Array.from(this.workspaces.values()).sort((a, b) => a.index - b.index);
    }

    getActiveWorkspace(): Workspace | undefined {
        return this.workspaces.get(this.activeWorkspaceId);
    }

    getWorkspaceByIndex(index: number): Workspace | undefined {
        return Array.from(this.workspaces.values()).find(w => w.index === index);
    }

    async createWorkspace(index?: number): Promise<Workspace | null> {
        if (this.workspaces.size >= this.maxWorkspaces) {
            return null;
        }

        const workspaceIndex = index ?? this.getNextAvailableIndex();
        if (workspaceIndex === -1) return null;

        // Create a new pane for the workspace
        const pane = await this.window.make("https://google.com");
        const newLeaf = pane.leaf;

        const workspace: Workspace = {
            id: uuid(),
            name: `Workspace ${workspaceIndex + 1}`,
            index: workspaceIndex,
            root: newLeaf,
            serializedRoot: null,
            activeNodeId: newLeaf.id,
            lastActivePaneId: newLeaf.id,
            lastAccessed: Date.now(),
            isActive: false,
        };

        this.workspaces.set(workspace.id, workspace);
        
        // Immediately hide the new workspace panes
        this.hideWorkspacePanes(workspace);
        
        // Trigger save
        this.window.debouncedSave();
        
        return workspace;
    }

    async switchToWorkspace(workspaceId: string): Promise<boolean> {
        const targetWorkspace = this.workspaces.get(workspaceId);
        if (!targetWorkspace) return false;

        const currentWorkspace = this.getActiveWorkspace();
        let currentWorkspaceMuted = false;
        
        if (currentWorkspace && currentWorkspace.id !== workspaceId) {
            await this.captureWorkspacePreview(currentWorkspace.id);
            
            // Save current mute state before hiding
            currentWorkspaceMuted = this.isWorkspaceMuted(currentWorkspace);
            
            // Save current workspace state
            currentWorkspace.isActive = false;
            if (this.window.root) {
                currentWorkspace.root = this.window.root;
                currentWorkspace.lastActivePaneId = this.window.lastActivePaneId;
                const activeLeaf = this.findActiveLeaf(this.window.root);
                currentWorkspace.activeNodeId = activeLeaf?.id || currentWorkspace.activeNodeId;
            }
            
            // Hide current panes (but don't destroy them!)
            this.hideWorkspacePanes(currentWorkspace);
        }

        // Restore target workspace if needed
        if (!targetWorkspace.root && targetWorkspace.serializedRoot) {
            // Need to restore from serialized state
            targetWorkspace.root = await this.window.restoreNode(targetWorkspace.serializedRoot);
            targetWorkspace.serializedRoot = null;
            
            // Apply the saved mute state from the current workspace to newly created panes
            // This ensures consistent mute behavior across workspaces
            if (currentWorkspaceMuted) {
                this.setWorkspaceMuted(targetWorkspace, true);
            }
        }
        
        // Make sure we have a valid root
        if (!targetWorkspace.root) {
            console.error("No root for workspace", workspaceId);
            return false;
        }

        this.window.root = targetWorkspace.root;
        this.window.lastActivePaneId = targetWorkspace.lastActivePaneId || null;
        targetWorkspace.isActive = true;
        targetWorkspace.lastAccessed = Date.now();
        this.activeWorkspaceId = workspaceId;

        this.showWorkspacePanes(targetWorkspace);
        
        // Broadcast update immediately
        this.broadcastWorkspaceUpdate();
        
        // Update window's active pane and focus after a short delay
        setTimeout(() => {
            if (targetWorkspace.lastActivePaneId) {
                this.window.focus(targetWorkspace.lastActivePaneId);
            }
            // Ensure window itself is focused
            this.window.window.focus();
        }, 50);
        
        // No need for delayed captures - regular interval will handle it
        
        // Trigger save after switching
        this.window.debouncedSave();

        return true;
    }

    async switchToWorkspaceByIndex(index: number): Promise<boolean> {
        const workspace = this.getWorkspaceByIndex(index);
        if (!workspace) {
            const newWorkspace = await this.createWorkspace(index);
            if (!newWorkspace) return false;
            return this.switchToWorkspace(newWorkspace.id);
        }
        return this.switchToWorkspace(workspace.id);
    }
    
    removeWorkspace(workspaceId: string): boolean {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace) return false;
        
        // Don't allow removing the last workspace
        if (this.workspaces.size <= 1) return false;
        
        // If removing the active workspace, we'll need to switch to another
        const isActive = workspace.isActive;
        
        // Clean up workspace panes if they exist
        if (workspace.root) {
            this.forEachLeaf(workspace.root, (leaf) => {
                const pane = this.window.paneById.get(leaf.id);
                if (pane) {
                    // Remove from window's pane tracking
                    this.window.paneById.delete(leaf.id);
                    this.window.searchStates.delete(leaf.id);
                    this.window.overlayStates.delete(leaf.id);
                    this.window.biscuitStates.delete(leaf.id);
                    this.window.typingStates.delete(leaf.id);
                    
                    // Close the pane
                    pane.close();
                    
                    // Destroy the views
                    for (const layer of leaf.layers ?? []) {
                        try {
                            (layer as any)?.destroy?.();
                        } catch { }
                    }
                }
            });
        }
        
        // Remove the workspace
        this.workspaces.delete(workspaceId);
        
        // Update indices of remaining workspaces
        const remainingWorkspaces = this.getWorkspaces();
        remainingWorkspaces.forEach((ws, idx) => {
            ws.index = idx;
        });
        
        // Broadcast update and trigger save
        this.broadcastWorkspaceUpdate();
        this.window.debouncedSave();
        
        return true;
    }

    private hideWorkspacePanes(workspace: Workspace) {
        if (!workspace.root) return;
        
        this.forEachLeaf(workspace.root, (leaf) => {
            const pane = this.window.paneById.get(leaf.id);
            if (pane && leaf.view) {
                try {
                    this.window.window.contentView.removeChildView(leaf.view);
                    if (leaf.layers) {
                        leaf.layers.forEach(layer => {
                            try {
                                this.window.window.contentView.removeChildView(layer);
                            } catch (e) {
                                // Layer might not be in view
                            }
                        });
                    }
                } catch (error) {
                    console.error("Error hiding pane:", error);
                }
            }
        });
    }

    private showWorkspacePanes(workspace: Workspace) {
        if (!workspace.root) return;
        
        this.forEachLeaf(workspace.root, (leaf) => {
            const pane = this.window.paneById.get(leaf.id);
            if (pane) {
                try {
                    this.window.window.contentView.addChildView(leaf.view);
                    if (leaf.layers) {
                        leaf.layers.forEach(layer => {
                            this.window.window.contentView.addChildView(layer);
                        });
                    }
                } catch (error) {
                    console.error("Error showing pane:", error);
                }
            }
        });
        
        // Trigger layout recalculation
        const { sendState } = require("../pane/layout");
        sendState(this.window.window, workspace.root);
    }

    toggleMute(): void {
        const activeWorkspace = this.getActiveWorkspace();
        if (!activeWorkspace || !activeWorkspace.root) return;
        
        // Check current mute state from first pane
        const isMuted = this.isWorkspaceMuted(activeWorkspace);
        
        // Toggle mute on all panes in workspace
        this.setWorkspaceMuted(activeWorkspace, !isMuted);
        
        // Broadcast the update
        this.broadcastWorkspaceUpdate();
    }
    
    private isWorkspaceMuted(workspace: Workspace): boolean {
        if (!workspace.root) return false;
        
        // Check if any pane is muted (they should all have same state)
        let isMuted = false;
        this.forEachLeaf(workspace.root, (leaf) => {
            if (leaf.view?.webContents && !leaf.view.webContents.isDestroyed()) {
                isMuted = leaf.view.webContents.isAudioMuted();
            }
        });
        
        return isMuted;
    }
    
    private setWorkspaceMuted(workspace: Workspace, muted: boolean): void {
        if (!workspace.root) return;
        
        this.forEachLeaf(workspace.root, (leaf) => {
            if (leaf.view?.webContents && !leaf.view.webContents.isDestroyed()) {
                leaf.view.webContents.setAudioMuted(muted);
            }
        });
    }
    
    private isWorkspaceAudible(workspace: Workspace): boolean {
        if (!workspace.root) return false;
        
        let isAudible = false;
        this.forEachLeaf(workspace.root, (leaf) => {
            if (leaf.view?.webContents && !leaf.view.webContents.isDestroyed()) {
                if (leaf.view.webContents.isCurrentlyAudible()) {
                    isAudible = true;
                }
            }
        });
        
        return isAudible;
    }

    async captureWorkspacePreview(workspaceId: string): Promise<void> {
        const workspace = this.workspaces.get(workspaceId);
        if (!workspace) return;

        try {
            // Use desktopCapturer to capture the entire window with all panes
            const windowBounds = this.window.window.getContentBounds();
            const sources = await desktopCapturer.getSources({
                types: ['window'],
                thumbnailSize: {
                    width: windowBounds.width,
                    height: windowBounds.height
                }
            });
            
            // Find our window by ID
            const windowId = this.window.window.getMediaSourceId();
            const source = sources.find(s => s.id === windowId);
            
            if (source && source.thumbnail) {
                // Send the full resolution image - let the frontend handle sizing
                workspace.preview = source.thumbnail.toDataURL();
            } else {
                // Fallback to capturing just the active pane
                const firstLeaf = this.findActiveLeaf(workspace.root);
                if (!firstLeaf || !firstLeaf.view) return;
                
                const image = await firstLeaf.view.webContents.capturePage();
                workspace.preview = image.toDataURL();
            }
            
            // Notify renderer of workspace update
            this.broadcastWorkspaceUpdate();
        } catch (error) {
            console.error("Failed to capture workspace preview:", error);
        }
    }
    
    private broadcastWorkspaceUpdate() {
        // Send workspace update to all panes - serialize the data first
        const serializedWorkspaces = this.getWorkspaces().map(workspace => ({
            id: workspace.id,
            name: workspace.name,
            index: workspace.index,
            preview: workspace.preview,
            lastAccessed: workspace.lastAccessed,
            isActive: workspace.isActive,
            isMuted: this.isWorkspaceMuted(workspace),
            isAudible: this.isWorkspaceAudible(workspace),
        }));
        
        this.window.paneById.forEach(pane => {
            pane.leaf.layers?.forEach(layer => {
                try {
                    layer.webContents.send("workspace:update", serializedWorkspaces);
                } catch (error) {
                    console.error("Failed to send workspace update:", error);
                }
            });
        });
    }

    private getNextAvailableIndex(): number {
        for (let i = 0; i < this.maxWorkspaces; i++) {
            if (!this.getWorkspaceByIndex(i)) {
                return i;
            }
        }
        return -1;
    }
    
    getState(): WorkspaceState {
        // Serialize all workspaces for saving
        const serializedWorkspaces = Array.from(this.workspaces.values()).map(workspace => {
            return {
                ...workspace,
                root: null, // Don't save the live root
                serializedRoot: workspace.root ? serializeNode(workspace.root) : workspace.serializedRoot,
            };
        });
        
        return {
            workspaces: serializedWorkspaces,
            activeWorkspaceId: this.activeWorkspaceId,
        };
    }
    
    loadState(state: WorkspaceState) {
        if (!state) return;
        
        this.workspaces.clear();
        
        // Restore workspaces from state
        state.workspaces.forEach(ws => {
            const workspace: Workspace = {
                id: ws.id,
                name: ws.name,
                index: ws.index,
                root: null, // Will be restored when switching to it
                serializedRoot: ws.serializedRoot,
                activeNodeId: ws.activeNodeId,
                lastActivePaneId: ws.lastActivePaneId,
                preview: ws.preview,
                lastAccessed: ws.lastAccessed,
                isActive: false,
            };
            this.workspaces.set(workspace.id, workspace);
        });
        
        this.activeWorkspaceId = state.activeWorkspaceId || '';
        
        // Mark the active workspace
        const activeWorkspace = this.getActiveWorkspace();
        if (activeWorkspace) {
            activeWorkspace.isActive = true;
        }
    }
    
    // Restore node with unique IDs to prevent conflicts between workspaces
    private async restoreWorkspaceNode(node: any, workspaceId: string): Promise<Node> {
        if (!node) return null as any;
        
        if (node.kind === "leaf") {
            // Generate a new unique ID for this workspace
            const newId = Date.now() + Math.floor(Math.random() * 10000);
            const restoredNode = await this.window.restoreNode({
                ...node,
                id: newId
            });
            
            // Update the workspace's record of this pane ID
            if (node.id === this.workspaces.get(workspaceId)?.lastActivePaneId) {
                const workspace = this.workspaces.get(workspaceId);
                if (workspace) {
                    workspace.lastActivePaneId = newId;
                }
            }
            
            return restoredNode;
        } else {
            // Recursively restore split nodes
            const a = await this.restoreWorkspaceNode(node.a, workspaceId);
            const b = await this.restoreWorkspaceNode(node.b, workspaceId);
            return {
                kind: "split",
                dir: node.dir,
                size: node.size,
                a,
                b
            } as Split;
        }
    }

}
