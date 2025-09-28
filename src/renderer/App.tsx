import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  KeyboardEvent,
} from "react";

import { PaneState } from "../electron/pane/types";

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState("");
  const [panes, setPanes] = useState<PaneState[]>([]);

  const [faviconError, setFaviconError] = useState(false);

  const currentPaneId = (window as any).native.getCurrentPaneId();
  const currentPane = panes.find((pane) => pane.id === currentPaneId);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      window.native.searchSubmit(currentPaneId, search);
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      window.native.searchBlur(currentPaneId);
      (e.currentTarget as HTMLInputElement).blur();
    }
  };

  useEffect(() => {
    const fetchPanes = async () => {
      setPanes(await window.native.listPanes());
    };

    const onPanes = window.native.onPanes((panes) => setPanes(panes));
    const onOverlayFocus = window.native.onOverlayFocus((focused) => {
      if (!inputRef.current) return;

      if (focused) {
        setSearch(currentPane?.url || "");

        inputRef.current.focus();
        inputRef.current.select();
      } else {
        inputRef.current.blur();
      }
    });
    
    const onSearchUpdate = window.native.onSearchUpdate(({ paneId, query }) => {
      if (paneId === currentPaneId) {
        setSearch(query);
      }
    });
    
    const onSearchFocus = window.native.onSearchFocus(({ paneId, isFocused }) => {
      if (paneId === currentPaneId && inputRef.current) {
        if (isFocused) {
          inputRef.current.focus();
          inputRef.current.select();
        } else {
          inputRef.current.blur();
        }
      }
    });

    fetchPanes();

    return () => {
      onPanes();
      onOverlayFocus();
      onSearchUpdate();
      onSearchFocus();
    };
  }, [currentPaneId]);

  useEffect(() => {
    setSearch(currentPane?.url || "");
  }, [currentPane?.url]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    window.native.searchInput(currentPaneId, value);
  }, [currentPaneId]);

  return (
    <div className="w-full h-full flex items-center justify-center text-white">
      <div
        className="mt-auto w-full flex flex-col gap-4 border-t-3 border-black relative"
        style={{
          backgroundColor: currentPane?.backgroundColor,
          color: "#000000",
        }}
      >
        {/* <div
          className="bg-[#000000] w-92 h-48"
          style={{
            backgroundImage: `url(${currentPane?.image})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        /> */}

        <div className="flex flex-row items-center justify-between gap-8 p-3">
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a URL or search…"
            className="bg-transparent text-inherit text-xs w-full outline-none"
            spellCheck={false}
          />

          <h1 className="text-xs flex flex-row items-center gap-2 pr-2">
            <img
              src={currentPane?.favicon}
              alt="favicon"
              className="w-4 h-4"
              onError={() => setFaviconError(true)}
              style={{
                display: faviconError ? "none" : "block",
              }}
            />
            <span className="whitespace-nowrap max-w-[10%]">
              {currentPane?.title}
            </span>
          </h1>
        </div>
      </div>
    </div>
  );
}
