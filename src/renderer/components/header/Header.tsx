import React, { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";

import { PaneState } from "../../types/pane";
import { isLikelyUrl, normalizeUrlSmart } from "../../utils/url";
import { cn } from "../../utils/cn";

export function Header({
    pane,
    active,
    onFocus,
    inputRef,
}: {
    pane: PaneState;
    active: boolean;
    onFocus: () => void;
    inputRef: (el: HTMLInputElement | null) => void;
}) {
    const [val, setVal] = useState(pane.url);
    const tRef = useRef<number | null>(null);

    useEffect(() => setVal(pane.url), [pane.url]);

    useEffect(() => {
        if (tRef.current) window.clearTimeout(tRef.current);
        tRef.current = window.setTimeout(() => {
            const s = val.trim();
            if (!s || /\s/.test(s)) return;
            if (isLikelyUrl(s)) {
                const url = normalizeUrlSmart(s);
                window.native.navigatePane(pane.id, url);
            }
        }, 450);
        return () => {
            if (tRef.current) window.clearTimeout(tRef.current);
        };
    }, [val]);

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            const s = val.trim();
            if (!s) return;
            if (isLikelyUrl(s)) {
                const url = normalizeUrlSmart(s);
                window.native.navigatePane(pane.id, url);
                setVal(url);
            } else {
                window.native.navigatePane(
                    pane.id,
                    `https://www.google.com/search?q=${encodeURIComponent(s)}`
                );
            }
            // Blur after committing with Enter
            (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
        }
    };

    // Match BrowserView interior gutters (2px on interior edges only)
    const GUTTER = 2;
    const w = window.innerWidth || 0;
    const leftG = pane.rect.x > 0 ? GUTTER : 0;
    const rightG = pane.rect.x + pane.rect.width < w ? GUTTER : 0;

    const posStyle: CSSProperties = {
        position: "fixed",
        left: pane.rect.x + leftG,
        top: pane.rect.y,
        width: pane.rect.width - (leftG + rightG),
        // WebkitAppRegion: "drag",
    };

    return (
        <div
            style={posStyle}
            className={cn(
                "flex items-center h-[30px] px-[2px] py-[1px] z-[1000] box-border border-b-2 text-[#e7e7ea] border-[#1d1f28]",
                active ? "bg-slate-200" : "bg-slate-900"
            )}
        >
            <input
                ref={inputRef}
                value={val}
                onChange={(e) => setVal(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Type a URL or search…"
                className={cn(
                    "flex-1 h-[26px] border border-[#2b2d36] rounded-[6px] px-[10px] outline-none bg-transparent",
                    "text-inherit"
                )}
                // style={{ WebkitAppRegion: "no-drag" as any }}
                onFocus={() => window.native.omniboxFocus(true)}
                onBlur={() => window.native.omniboxFocus(false)}
                spellCheck={false}
            />
        </div>
    );
}
