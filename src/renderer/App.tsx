import React, {
    useEffect,
    useState,
    useCallback,
    useRef,
    KeyboardEvent,
    useMemo,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Volume2, VolumeOff } from "lucide-react";

import { PaneState } from "../electron/pane/types";
import { SerializedWorkspace } from "../electron/workspace/types";
import { getOverlayStyles } from "./utils/colors";
import { getDominantColor } from "./utils/dominantColor";
import noiseGif from "./assets/noise.gif";

export default function App() {
    const inputRef = useRef<HTMLInputElement>(null);

    const [search, setSearch] = useState("");
    const [panes, setPanes] = useState<PaneState[]>([]);
    const [workspaces, setWorkspaces] = useState<SerializedWorkspace[]>([]);
    const [overlayVisible, setOverlayVisible] = useState(false); // Start hidden to avoid flash
    const [animationKey, setAnimationKey] = useState(0); // Key to force animation restart

    const [faviconError, setFaviconError] = useState(false);

    const [focused, setFocused] = useState(false);

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

        const onPanes = window.native.onPanes((panes) => {
            console.log(`[OVERLAY] Received panes update:`, panes.map(p => ({ id: p.id, url: p.url, title: p.title, image: p.image })));
            setPanes(panes);

            // Force update of search if current pane changed
            const updatedCurrentPane = panes.find(p => p.id === currentPaneId);
            if (updatedCurrentPane && updatedCurrentPane.url !== currentPane?.url) {
                console.log(`[OVERLAY] Current pane URL changed from ${currentPane?.url} to ${updatedCurrentPane.url}`);
                setSearch(updatedCurrentPane.url);
            }
        });

        const onSearchUpdate = window.native.onSearchUpdate(({ paneId, query }) => {
            if (paneId === currentPaneId) {
                setSearch(query);
            }
        });

        const onSearchFocus = window.native.onSearchFocus(({ paneId, isFocused }) => {
            if (paneId === currentPaneId) {
                setFocused(isFocused);  // This will trigger the animation key increment
                setOverlayVisible(isFocused);

                if (inputRef.current) {
                    if (isFocused) {
                        inputRef.current.focus();
                        inputRef.current.select();
                    } else {
                        inputRef.current.blur();
                    }
                }
            }
        });

        fetchPanes();

        const fetchWorkspaces = async () => {
            const workspaceList = await window.native.listWorkspaces();
            setWorkspaces(workspaceList);
        };

        fetchWorkspaces();

        return () => {
            onPanes();
            onSearchUpdate();
            onSearchFocus();
        };
    }, [currentPaneId]);

    const [dominantColor, setDominantColor] = useState<string>("#000000");

    useEffect(() => {
        console.log(`[OVERLAY] Current pane changed:`, {
            id: currentPane?.id,
            url: currentPane?.url,
            image: currentPane?.image
        });
        setSearch(currentPane?.url || "");
        setFaviconError(false);

        if (currentPane?.image) {
            getDominantColor(currentPane.image).then(color => {
                setDominantColor(color);
            });
        } else {
            setDominantColor("#000000");
        }
    }, [currentPane?.url, currentPane?.image]);

    useEffect(() => {
        const onOverlayFocus = window.native.onOverlayFocus((focused) => {
            setFocused(focused);
            setOverlayVisible(focused);

            if (!inputRef.current) return;

            if (focused) {
                window.native.listPanes().then(freshPanes => {
                    setPanes(freshPanes);

                    const freshCurrentPane = freshPanes.find(p => p.id === currentPaneId);
                    if (freshCurrentPane?.url) {
                        setSearch(freshCurrentPane.url);
                    }
                });

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
    }, [currentPaneId]);

    useEffect(() => {
        if (focused) setAnimationKey(prev => prev + 1);
    }, [focused])

    useEffect(() => {
        if (overlayVisible && inputRef.current) {
            const timer = setTimeout(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [overlayVisible]);

    useEffect(() => {
        const onWorkspaceUpdate = window.native.onWorkspaceUpdate((updatedWorkspaces) => {
            setWorkspaces(updatedWorkspaces);

        });

        return () => {
            onWorkspaceUpdate();
        };
    }, []);

    const handleSearchChange = useCallback((value: string) => {
        setSearch(value);

        window.native.searchInput(currentPaneId, value);
    }, [currentPaneId]);

    // Focus input immediately when it mounts
    const inputCallbackRef = useCallback((input: HTMLInputElement | null) => {
        inputRef.current = input;
        if (input && overlayVisible) {
            input.focus();
            input.select();
        }
    }, [overlayVisible]);

    const overlayStyles = getOverlayStyles(currentPane);
    const accentColor = dominantColor;
    const currentWorkspace = workspaces.find(ws => ws.isActive);

    if (!overlayVisible) {
        return <div className="w-full h-full" />;
    }

    return (
        <AnimatePresence mode="wait">
            <motion.div
                key={`overlay-content-${animationKey}`}
                className="w-full h-full flex items-center justify-center relative"
                transition={{ duration: 0.1 }}
            >
                <div
                    className="absolute inset-0 pointer-events-none opacity-5 mix-blend-overlay"
                    style={{
                        backgroundImage: `url(${noiseGif})`,
                        backgroundSize: '200px 200px',
                        backgroundRepeat: 'repeat',
                    }}
                />

                <motion.div
                    className="absolute inset-0 opacity-10 mix-blend-overlay"
                    animate={{
                        background: [
                            `linear-gradient(135deg, transparent 0%, ${accentColor} 100%)`,
                            `linear-gradient(225deg, transparent 0%, ${accentColor} 100%)`,
                            `linear-gradient(315deg, transparent 0%, ${accentColor} 100%)`,
                            `linear-gradient(45deg, transparent 0%, ${accentColor} 100%)`,
                            `linear-gradient(135deg, transparent 0%, ${accentColor} 100%)`,
                        ],
                    }}
                    transition={{
                        duration: 20,
                        repeat: Infinity,
                        ease: "linear"
                    }}
                />

                <motion.div
                    className="h-full w-full flex flex-col relative shadow-2xl search-container"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.1 }}
                >
                    <motion.div
                        className="flex flex-row items-center justify-between gap-4 p-4 relative z-[2]"
                        style={{
                            ...overlayStyles
                        }}
                        transition={{ duration: 0.1 }}
                    >
                        {currentPane?.favicon && !faviconError && (
                            <img
                                src={currentPane.favicon}
                                alt=""
                                className="w-4 h-4"
                                onError={() => setFaviconError(true)}
                            />
                        )}

                        <input
                            ref={inputCallbackRef}
                            value={search}
                            onChange={(e) => handleSearchChange(e.target.value)}
                            onKeyDown={onKeyDown}
                            placeholder="Type a URL or search…"
                            className="bg-transparent text-inherit text-sm w-full outline-none placeholder-current placeholder-opacity-50"
                            spellCheck={false}
                        />
                    </motion.div>

                    <AnimatePresence>
                        {currentPane?.description && (
                            <motion.div
                                className="flex flex-row items-center justify-between gap-4 px-4 py-2 border-y-[1px] relative z-[1]"
                                style={{
                                    ...overlayStyles,
                                    borderColor: accentColor,
                                }}
                                initial={{ opacity: 0, y: -40 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -40 }}
                                transition={{ duration: 0.2, delay: 0.1 }}
                            >
                                <p className="text-xs opacity-60">
                                    <span className="whitespace-nowrap">{currentPane?.title}</span>
                                </p>
                                <p className="text-xs opacity-60 whitespace-nowrap truncate">{currentPane.description}</p>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    <div className="inset-0 absolute overflow-hidden">
                        <motion.div
                            key={`bg-${currentPane?.id}-${currentPane?.image || currentWorkspace?.preview}`}
                            className="inset-0 absolute filter blur-[30px]"
                            style={{
                                backgroundImage: currentPane?.image ? `url(${currentPane.image})` : undefined,
                                backgroundSize: 'cover',
                                backgroundPosition: 'center',
                                scale: '1.05',
                                mixBlendMode: 'multiply' as any,
                                maskImage: 'radial-gradient(ellipse 50% 50% at center, transparent 0%, black 100%)',
                                WebkitMaskImage: 'radial-gradient(ellipse 50% 50% at center, transparent 0%, black 100%)',
                            }}
                            initial={{ opacity: 0, scale: 2.05, rotate: -115 }}
                            animate={{ opacity: 1, scale: [2.05, 2.1, 2.05], rotate: [-115, 0, 115] }}
                            transition={{ duration: 30 }}
                        />
                        <motion.div
                            key={`bg-${currentPane?.id}-${currentPane?.image || currentWorkspace?.preview}`}
                            className="inset-0 absolute filter blur-[30px]"
                            style={{
                                backgroundImage: currentPane?.image ? `url(${currentPane.image})` : undefined,
                                backgroundSize: 'cover',
                                backgroundPosition: 'center',
                                scale: '1.05',
                                mixBlendMode: 'multiply' as any,
                                maskImage: 'radial-gradient(ellipse 50% 50% at center, transparent 0%, black 100%)',
                                WebkitMaskImage: 'radial-gradient(ellipse 50% 50% at center, transparent 0%, black 100%)',
                            }}
                            initial={{ opacity: 0, scale: 2.05, rotate: 115 }}
                            animate={{ opacity: 1, scale: [2.05, 2.1, 2.05], rotate: [115, 0, -115] }}
                            transition={{ duration: 30 }}
                        />
                    </div>

                    <motion.div
                        className="relative mb-auto"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{
                            delay: 0.1,
                            duration: 0.2
                        }}
                    >
                        <AnimatePresence mode="wait">
                            {currentPane?.image && (
                                <motion.img
                                    key={`blur-${currentPane.id}-${currentPane.image}`}
                                    src={currentPane.image}
                                    alt={"pane image"}
                                    className="w-full h-full object-cover max-w-92 max-h-48 m-4 rounded-lg filter blur-[40px] absolute"
                                    style={{
                                        borderColor: accentColor,
                                        scale: '1.05',
                                        mixBlendMode: 'overlay' as any,
                                    }}
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.3 }}
                                />
                            )}
                        </AnimatePresence>
                        {currentPane?.image && (
                            <motion.img
                                key={`main-${currentPane.id}-${currentPane.image}`}
                                src={currentPane.image}
                                alt={"pane image"}
                                className="w-full h-full object-cover max-w-92 max-h-48 m-4 rounded-lg border-[1px] relative"
                                style={{
                                    borderColor: accentColor,
                                }}
                                whileHover={{ scale: 1.02 }}
                            />
                        )}
                    </motion.div>

                    {workspaces.length > 0 && (
                        <motion.div
                            className="flex flex-row items-center gap-4 px-4 mb-4"
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ duration: 0.1 }}
                        >
                            {workspaces.map((workspace) => (
                                <motion.button
                                    key={workspace.id}
                                    onClick={() => window.native.switchWorkspace(workspace.id)}
                                    className={`max-w-92 h-48 flex-shrink-0 relative rounded-lg transition-all border-[1px]`}
                                    style={{
                                        borderColor: accentColor
                                    }}
                                    initial={{ opacity: 0, translateY: "50%" }}
                                    animate={{ opacity: 1, translateY: "0%" }}
                                    transition={{
                                        delay: workspace.index * 0.05,
                                        duration: 0.1,
                                    }}
                                >
                                    {workspace.preview ? (
                                        <>
                                            <motion.img
                                                src={workspace.preview}
                                                alt={workspace.name}
                                                className="w-full h-full object-cover filter relative rounded-lg z-[2]"
                                                style={{
                                                    scale: '1.05',
                                                    mixBlendMode: 'overlay' as any,
                                                }}
                                                animate={{ filter: ["blur(50px)", "blur(55px)", "blur(50px)"] }}
                                                transition={{ duration: 5, repeat: Infinity }}
                                            />
                                            <img
                                                src={workspace.preview}
                                                alt={workspace.name}
                                                className="w-full h-full object-cover absolute rounded-lg z-[8] inset-0"
                                            />
                                        </>
                                    ) : (
                                        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                                            <span className="text-xs text-white/50">{workspace.index + 1}</span>
                                        </div>
                                    )}

                                    <div className="flex flex-row items-center gap-2 absolute -top-6 left-0 right-0 z-[10] justify-between">
                                        <p className="h-5 z-[10] text-xs items-center flex justify-center p-1 rounded-sm border-[1px] bg-white/10" style={{ 
                                            ...overlayStyles, 
                                            borderColor: accentColor 
                                        }}>
                                            {workspace.index + 1}
                                        </p>

                                        {(workspace.isMuted || workspace.isAudible) && (
                                            <p className="z-[10] items-center flex justify-center p-1 h-5 rounded-sm border-[1px]" style={{ 
                                                ...overlayStyles, 
                                                borderColor: accentColor 
                                            }}>
                                                {workspace.isMuted ? (
                                                    <VolumeOff className="w-3 h-3" />
                                                ) : (
                                                    <Volume2 className="w-3 h-3" />
                                                )}
                                            </p>
                                        )}
                                    </div>
                                </motion.button>
                            ))}
                        </motion.div>
                    )}
                </motion.div>
            </motion.div>
        </AnimatePresence>
    );
}
