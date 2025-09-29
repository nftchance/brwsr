import { ipcRenderer } from "electron";

const HINT_CHARS = 'asdghjklqwertuiopzxcvbnm';

type Target = { el: Element; rect: DOMRect; tag: string; href?: string | null };

let typed = '';
let overlay: null | ReturnType<typeof makeOverlay> = null;
let cleanup: null | (() => void) = null;
let mutationObs: MutationObserver | null = null;
let scrollHandler: any = null;
let cursor = 0;
let selectionTimeout: NodeJS.Timeout | null = null;

export const getTargets = (): Target[] => {
    const clickable = [
        'a[href]',
        'button',
        '[role="button"]',
        'input:not([type="hidden"])',
        'textarea',
        'summary',
        '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    const els = Array.from(document.querySelectorAll(clickable))
        .filter(el => {
            const r = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return r.width > 8 && r.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
        });

    return els.map(el => ({
        el,
        rect: el.getBoundingClientRect(),
        tag: el.tagName.toLowerCase(),
        content: el.getHTML(),
        href: (el as HTMLAnchorElement).href
    }));
};

export const getLabels = (n: number): string[] => {
    const chars = HINT_CHARS.split('');
    const out: string[] = [];
    
    // For small numbers, use single characters
    if (n <= chars.length) {
        return chars.slice(0, n);
    }
    
    // For larger numbers, use a smarter distribution that avoids prefixes
    // We'll use a two-character system where the first character determines
    // the "group" and second character determines the item within that group
    
    // Calculate how many items per first character we need
    const itemsPerFirstChar = Math.ceil(n / chars.length);
    const charsNeededForSecond = Math.min(itemsPerFirstChar, chars.length);
    
    // Generate labels without prefix collisions
    for (let i = 0; i < chars.length && out.length < n; i++) {
        const firstChar = chars[i];
        
        // If we only need one item for this first char, use the single character
        if (itemsPerFirstChar === 1) {
            out.push(firstChar);
        } else {
            // Otherwise, create two-character combinations
            for (let j = 0; j < charsNeededForSecond && out.length < n; j++) {
                out.push(firstChar + chars[j]);
            }
        }
    }
    
    return out;
};

// TODO: We should figure out how to inject our react in here instead.
//       -- It should be possible since we have loadFile confirmation already.

export const makeOverlay = (targets: Target[]) => {
    const host = document.createElement('div');
    host.id = '__hint_host__';
    Object.assign(host.style, {
        position: 'fixed', left: '0', top: '0', width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: '2147483647'
    });

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
    .hint {
      position: absolute;
      font: 12px/1 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      padding: 2px 4px;
      border-radius: 3px;
      background: #000;
      color: #fff;
      border: 1px solid #333;
      pointer-events: none;
      transform: translate(-50%, -100%);
      white-space: nowrap;
      user-select: none;
      max-width: 30vw;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .hidden { display: none; }
    .typed-ok { background:#0b5; color:#fff; border-color:#084; }
    .active { outline: 2px solid #fff; }
    .meta { opacity: .7; color:#ddd; margin-left:.5em; font-weight: 500; }
  `;
    shadow.appendChild(style);


    const labels = getLabels(targets.length);
    const map: Record<string, Target & { node: HTMLDivElement; label: string }> = {};

    targets.forEach((t, i) => {
        const label = labels[i];
        // Skip if no label
        if (!label) return;
        
        const div = document.createElement('div');
        div.className = 'hint';
        const metaSpan = document.createElement('span');
        metaSpan.className = 'meta';
        // @ts-ignore
        metaSpan.textContent = t.meta ? ' ' + t.meta.slice(0, 60) : '';
        div.textContent = label;
        div.appendChild(metaSpan);
        shadow.appendChild(div);
        map[label] = { ...t, node: div, label };
    });

    document.documentElement.appendChild(host);

    const teardown = () => host.remove();
    return { host, shadow, map, teardown };
};

export const redrawPositions = () => {
    if (!overlay) return;
    for (const v of Object.values(overlay.map)) {
        const r = (v.el as HTMLElement).getBoundingClientRect();
        // Use viewport-relative positioning since our overlay is position: fixed
        v.node.style.left = `${Math.max(6, r.left + 8)}px`;
        v.node.style.top = `${Math.max(6, r.top + 8)}px`;
        const off = r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth;
        v.node.classList.toggle('hidden', off);
    }
};

export const activate = () => {
    if (overlay) return;

    typed = '';
    cursor = 0;
    const targets = getTargets();
    overlay = makeOverlay(targets);
    redrawPositions();
    updateDisplay();

    scrollHandler = () => redrawPositions();
    window.addEventListener('scroll', scrollHandler, { passive: true });
    window.addEventListener('resize', scrollHandler);

    mutationObs = new MutationObserver(() => {
        // Don't reactivate if we're in the middle of navigation
        if (window.location.href === 'about:blank' || document.readyState === 'loading') {
            deactivate();
            return;
        }
        deactivate();
        activate();
    });
    mutationObs.observe(document.documentElement, { childList: true, subtree: true });

    cleanup = () => {
        mutationObs?.disconnect();
        window.removeEventListener('scroll', scrollHandler);
        window.removeEventListener('resize', scrollHandler);
        overlay?.teardown();
        overlay = null;
    };
};

export const deactivate = () => {
    typed = '';
    cursor = 0;
    if (selectionTimeout) {
        clearTimeout(selectionTimeout);
        selectionTimeout = null;
    }
    cleanup?.();
    cleanup = null;
};

export const updateTyped = (newTyped: string) => {
    typed = newTyped;
    updateDisplay();
    checkSelection();
};

export const updateDisplay = () => {
    if (!overlay) return;
    
    // Update hint visibility and styling
    for (const [label, item] of Object.entries(overlay.map)) {
        const isMatch = typed === '' || label.startsWith(typed);
        const isExact = label === typed;
        
        item.node.classList.toggle('hidden', !isMatch);
        item.node.classList.toggle('typed-ok', isMatch && typed !== '');
        item.node.classList.toggle('active', isExact);
    }
};

export const checkSelection = () => {
    if (!overlay || !typed) return;
    
    // Clear any existing timeout
    if (selectionTimeout) {
        clearTimeout(selectionTimeout);
        selectionTimeout = null;
    }
    
    // Check if typed exactly matches a label
    const exactMatch = overlay.map[typed];
    if (!exactMatch) return;
    
    // With our new label system, we can select immediately
    // since there are no prefix collisions
    performSelection(exactMatch);
};

const performSelection = (match: any) => {
    // First deactivate the visual elements
    deactivate();
    
    // Get pane ID from command line args to send completion message
    const paneIdArg = process.argv.find(arg => arg.startsWith('--paneId='));
    const paneId = paneIdArg ? parseInt(paneIdArg.split('=')[1]) : 0;
    
    // Then notify main process that biscuits are being deactivated
    ipcRenderer.send('pane:biscuits:completed', { paneId });
    
    // For links, navigate directly instead of clicking
    // This ensures we always navigate in the same pane
    if (match.href && match.tag === 'a') {
        // Use location.assign() to add to history instead of replacing
        window.location.assign(match.href);
    } else {
        // For other elements, simulate a click
        const el = match.el as HTMLElement;
        el.click();
        
        // For input elements, ensure they get focus
        if (match.tag === 'input' || match.tag === 'textarea' || el.contentEditable === 'true') {
            el.focus();
            
            // For text inputs, place cursor at the end
            if (match.tag === 'input' || match.tag === 'textarea') {
                const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
                const len = inputEl.value.length;
                inputEl.setSelectionRange(len, len);
            }
        }
    }
};

