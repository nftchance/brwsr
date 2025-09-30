import { Node } from "../pane/types";
import { SerializedNode } from "../storage/paneState";

export interface Workspace {
    id: string;
    name: string;
    index: number; // 0-8 for cmd-1-9
    root: Node | null;
    serializedRoot: SerializedNode | null; // Saved state when workspace is inactive
    activeNodeId: number;
    lastActivePaneId: number | null;
    preview?: string; // base64 screenshot
    lastAccessed: number;
    isActive: boolean;
}

export interface WorkspaceState {
    workspaces: Workspace[];
    activeWorkspaceId: string;
}

// Serializable workspace for IPC
export interface SerializedWorkspace {
    id: string;
    name: string;
    index: number;
    preview?: string;
    lastAccessed: number;
    isActive: boolean;
    isMuted?: boolean; // Computed from webContents state
    isAudible?: boolean; // Whether any pane is currently producing audio
}