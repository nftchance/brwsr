import { useEffect, useRef, useState } from "react";

import { Header } from "./components/header/Header";
import { PaneState } from "./types/pane";

export default function App() {
  const [panes, setPanes] = useState<PaneState[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const inputRefs = useRef<Map<number, HTMLInputElement>>(new Map());
  const SCROLL_STEP = 80;

  useEffect(() => {
    const unsub = window.native.onPanes((s) => {
      setPanes(s);
    });
    const unActive = window.native.onActive((id) => {
      setActiveId((prev) => (prev === id ? prev : id));
    });
    const unFocusOmni = window.native.onFocusOmni((id) => {
      const input = inputRefs.current.get(id);
      if (input) {
        window.native.omniboxFocus(true);
        input.focus();
        input.select();
      }
    });
    (async () => {
      const list = await window.native.listPanes();
      setPanes(list);
      if (list.length) {
        setActiveId(list[0].id);
        window.native.setActivePane(list[0].id);
      }
    })();
    return () => {
      unsub && unsub();
      unActive && unActive();
      unFocusOmni && unFocusOmni();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "l") return;

      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }

      if (activeId != null) {
        const input = inputRefs.current.get(activeId);
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key !== "j" && e.key !== "k") return;

      // If typing in an input/textarea/contentEditable, don't hijack j/k
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }

      if (activeId != null) {
        e.preventDefault();
        const dy = e.key === "j" ? SCROLL_STEP : -SCROLL_STEP;
        window.native.scrollPane(activeId, dy);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeId]);

  return (
    <div>
      {panes.map((p) => (
        <Header
          key={p.id}
          pane={p}
          active={p.id === activeId}
          onFocus={() => setActiveId(p.id)}
          inputRef={(el) => {
            if (el) inputRefs.current.set(p.id, el);
            else inputRefs.current.delete(p.id);
          }}
        />
      ))}
    </div>
  );
}
