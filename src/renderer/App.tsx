import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  KeyboardEvent,
} from "react";

import { PaneState } from "../electron/pane/types";
import { getOverlayStyles } from "./utils/colors";

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
      const panesList = await window.native.listPanes();
      setPanes(panesList);
      // Initialize search with current pane's URL
      const currentPaneData = panesList.find(p => p.id === currentPaneId);
      if (currentPaneData?.url) {
        setSearch(currentPaneData.url);
      }
    };

    const onPanes = window.native.onPanes((panes) => setPanes(panes));
    
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
      onSearchUpdate();
      onSearchFocus();
    };
  }, [currentPaneId]);

  useEffect(() => {
    setSearch(currentPane?.url || "");
    // Reset favicon error when pane changes
    setFaviconError(false);
  }, [currentPane?.url]);

  // Handle overlay focus/blur events
  useEffect(() => {
    const onOverlayFocus = window.native.onOverlayFocus((focused) => {
      if (!inputRef.current) return;

      if (focused) {
        // Set the current URL when overlay opens
        if (currentPane?.url) {
          setSearch(currentPane.url);
        }

        // Focus and select all text after a brief delay to ensure value is set
        setTimeout(() => {
          if (inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
          }
        }, 10);
      } else {
        inputRef.current.blur();
      }
    });

    return () => {
      onOverlayFocus();
    };
  }, [currentPane?.url]);

  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    window.native.searchInput(currentPaneId, value);
  }, [currentPaneId]);

  const overlayStyles = getOverlayStyles(currentPane);

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div
        className="mt-auto w-full flex flex-col gap-4 relative shadow-2xl search-overlay search-container"
        style={overlayStyles}
      >
        {/* <div
          className="bg-[#000000] w-92 h-48"
          style={{
            backgroundImage: `url(${currentPane?.image})`,
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        /> */}

        <div 
          className="flex flex-row items-center justify-between gap-8 p-4"
          style={{
            borderTop: `1px solid ${overlayStyles.color}20`, // 20 is ~12% opacity in hex
          }}
        >
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a URL or search…"
            className="bg-transparent text-inherit text-sm w-full outline-none placeholder-current placeholder-opacity-50"
            spellCheck={false}
          />

          <div className="text-xs flex flex-row items-center gap-2 opacity-60">
            {currentPane?.favicon && !faviconError && (
              <img
                src={currentPane.favicon}
                alt=""
                className="w-4 h-4"
                onError={() => setFaviconError(true)}
              />
            )}
            <span className="whitespace-nowrap overflow-hidden text-ellipsis max-w-[200px]">
              {currentPane?.title}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
