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

    // Clear cache if the cached element is no longer in the document
    if (cachedScrollElement && !document.body.contains(cachedScrollElement)) {
        cachedScrollElement = undefined;
    }

    const scrollableElement = findScrollableElement();
    
    if (scrollableElement) {
        scrollableElement.scrollBy(0, dy);
    } else {
        window.scrollBy(0, dy);
    }
});

// Helper to find scrollable element (reusable)
let cachedScrollElement: Element | null | undefined = undefined;

const findScrollableElement = () => {
    // Don't use cache if document is still loading
    if (document.readyState !== 'complete') {
        cachedScrollElement = undefined;
    }
    
    // Cache the result for performance, but validate it's still valid
    if (cachedScrollElement !== undefined) {
        // Check if cached element is still valid
        if (cachedScrollElement === null) {
            // null means window scroll - always re-evaluate after navigation
            // to ensure page has properly loaded
            return null;
        } else if (!document.body.contains(cachedScrollElement)) {
            // Cached element no longer in document
            cachedScrollElement = undefined;
        } else {
            // Element still exists, use it
            return cachedScrollElement;
        }
    }
    
    // First check if we can scroll the window itself
    const canScrollWindow = 
        window.scrollY > 0 || // Already scrolled
        document.body.scrollHeight > window.innerHeight ||
        document.documentElement.scrollHeight > window.innerHeight;
    
    if (canScrollWindow) {
        cachedScrollElement = null; // null means use window scroll
        return null;
    }

    // Only look for scrollable containers if window can't scroll
    // This handles apps like GitHub, Twitter, etc that prevent body scroll
    const elements = document.querySelectorAll('main, [role="main"], .main-content, #main-content, .container, .content');
    
    for (const el of elements) {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        
        if ((overflowY === 'auto' || overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') &&
            el.scrollHeight > el.clientHeight) {
            const rect = el.getBoundingClientRect();
            // Must be visible and take up significant space
            if (rect.width > window.innerWidth * 0.5 && 
                rect.height > window.innerHeight * 0.5 &&
                rect.top < 200) { // Near top of viewport
                cachedScrollElement = el;
                return el;
            }
        }
    }
    
    // If no good candidate found, fall back to window scroll
    cachedScrollElement = null;
    return null;
};

// Reset cache on navigation
window.addEventListener('popstate', () => { cachedScrollElement = undefined; });

// Reset cache when navigating to new pages
let lastUrl = window.location.href;
const checkUrlChange = () => {
    if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        cachedScrollElement = undefined;
    }
};

// Set up mutation observer when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        const observer = new MutationObserver(() => { 
            cachedScrollElement = undefined; 
            checkUrlChange();
        });
        observer.observe(document.body, { childList: true, subtree: true });
    });
} else {
    // DOM already loaded
    const observer = new MutationObserver(() => { 
        cachedScrollElement = undefined; 
        checkUrlChange();
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

// Also listen for navigation events that might not trigger popstate
document.addEventListener('DOMContentLoaded', () => {
    cachedScrollElement = undefined;
});

// Reset on any page unload/navigation
window.addEventListener('beforeunload', () => {
    cachedScrollElement = undefined;
});

ipcRenderer.on("pane:scrollToTop", (_e) => {
    if (isTypingContext()) return;
    
    const scrollableElement = findScrollableElement();
    if (scrollableElement) {
        scrollableElement.scrollTop = 0;
    } else {
        window.scrollTo(0, 0);
    }
});

ipcRenderer.on("pane:scrollToBottom", (_e) => {
    if (isTypingContext()) return;
    
    const scrollableElement = findScrollableElement();
    if (scrollableElement) {
        scrollableElement.scrollTop = scrollableElement.scrollHeight;
    } else {
        window.scrollTo(0, document.body.scrollHeight);
    }
});

// Biscuit mode handlers
ipcRenderer.on("pane:biscuits:activate", (_e) => {
    activate();
});

ipcRenderer.on("pane:biscuits:deactivate", (_e) => {
    deactivate();
    // Clear scroll cache when biscuits complete (likely navigation)
    cachedScrollElement = undefined;
});

ipcRenderer.on("pane:biscuits:update", (_e, data: { typed: string }) => {
    updateTyped(data.typed);
});

// Focus tracking for typing state
// Get pane ID from command line args
const paneIdArg = process.argv.find(arg => arg.startsWith('--paneId='));
const paneId = paneIdArg ? parseInt(paneIdArg.split('=')[1]) : 0;

const updateTypingState = () => {
    const isTyping = isTypingContext();
    // Use invoke to send to main process with pane ID
    ipcRenderer.invoke('pane:typing:update', { paneId, isTyping }).catch(() => {
        // Ignore errors if handler not ready yet
    });
};

// Send initial state when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        updateTypingState();
        // Monitor focus/blur events
        document.addEventListener('focusin', updateTypingState, true);
        document.addEventListener('focusout', updateTypingState, true);
    });
} else {
    updateTypingState();
    // Monitor focus/blur events
    document.addEventListener('focusin', updateTypingState, true);
    document.addEventListener('focusout', updateTypingState, true);
}

