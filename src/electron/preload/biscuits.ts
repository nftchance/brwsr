import { ipcRenderer } from "electron";

const HINT_CHARS = 'asdfghjklqwertuiopzxcvbnm';

type Target = { el: Element; rect: DOMRect; tag: string; href?: string | null };

let typed = '';
let overlay: null | ReturnType<typeof makeOverlay> = null;
let cleanup: null | (() => void) = null;
let mutationObs: MutationObserver | null = null;
let scrollHandler: any = null;
let cursor = 0;

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

export const activate = (hintsActive: boolean) => {
    if (hintsActive) return;

    hintsActive = true;
    typed = '';
    cursor = 0;
    const targets = getTargets();
    overlay = makeOverlay(targets);
    redrawPositions();

    scrollHandler = () => redrawPositions();
    window.addEventListener('scroll', scrollHandler, { passive: true });
    window.addEventListener('resize', scrollHandler);

    mutationObs = new MutationObserver(() => {
        deactivate(hintsActive);
        activate(hintsActive);
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

export const deactivate = (hintsActive: boolean) => {
    hintsActive = false;
    typed = '';
    cursor = 0;
    cleanup?.();
    cleanup = null;
};

