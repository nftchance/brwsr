import { ipcRenderer } from "electron";

const HINT_CHARS = 'asdfghjklqwertuiopzxcvbnm';

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
    let digits = 1;

    while (out.length < n) {
        const max = Math.pow(chars.length, digits);
        for (let i = 0; i < max && out.length < n; i++) {
            let s = '';
            let x = i;
            for (let d = 0; d < digits; d++) {
                s = chars[x % chars.length] + s;
                x = Math.floor(x / chars.length);
            }
            out.push(s);
        }
        digits++;
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

    #query {
      position: fixed; left: 50%; top: 10px; transform: translateX(-50%);
      background:#000c; color:#fff; padding:4px 8px; border-radius:6px;
      font: 13px/1.3 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      pointer-events: none;
    }
  `;
    shadow.appendChild(style);

    // query HUD
    const q = document.createElement('div');
    q.id = 'query';
    q.textContent = '';
    shadow.appendChild(q);

    const labels = getLabels(targets.length);
    const map: Record<string, Target & { node: HTMLDivElement; label: string }> = {};

    targets.forEach((t, i) => {
        const label = labels[i];
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
    return { host, shadow, map, queryNode: q, teardown };
};

export const redrawPositions = () => {
    if (!overlay) return;
    for (const v of Object.values(overlay.map)) {
        const r = (v.el as HTMLElement).getBoundingClientRect();
        v.node.style.left = `${Math.max(6, r.left + window.scrollX + 8)}px`;
        v.node.style.top = `${Math.max(6, r.top + window.scrollY + 8)}px`;
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
    
    // Update query display
    overlay.queryNode.textContent = typed || '';
    
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
    
    // Check if there are any labels that start with our typed string but are longer
    const longerMatches = Object.keys(overlay.map).filter(
        label => label.startsWith(typed) && label.length > typed.length
    );
    
    if (longerMatches.length > 0) {
        // Wait a bit to see if user will type more characters
        selectionTimeout = setTimeout(() => {
            performSelection(exactMatch);
        }, 300); // 300ms delay
    } else {
        // No ambiguity, select immediately
        performSelection(exactMatch);
    }
};

const performSelection = (match: any) => {
    // Notify main process that biscuits are being deactivated
    ipcRenderer.send('pane:biscuits:completed');
    
    // For links, navigate directly instead of clicking
    // This ensures we always navigate in the same pane
    if (match.href && match.tag === 'a') {
        window.location.href = match.href;
    } else {
        // For other elements, simulate a click
        const el = match.el as HTMLElement;
        el.click();
    }
    
    deactivate();
};

