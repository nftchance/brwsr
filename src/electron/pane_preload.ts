/* import { ipcRenderer } from "electron"; */
/**/
/* export * as preload from "./preload"; */
/**/
/* function deepestActiveElement(root: Document | ShadowRoot): Element | null { */
/*     let ae: any = root.activeElement; */
/*     while (ae && ae.shadowRoot && ae.shadowRoot.activeElement) { */
/*         ae = ae.shadowRoot.activeElement; */
/*     } */
/*     return ae as Element | null; */
/* } */
/**/
/* function isTypingContext(): boolean { */
/*     const el = deepestActiveElement(document); */
/*     if (!el) return false; */
/**/
/*     if ((el as any).isContentEditable) return true; */
/*     const ce = el.getAttribute?.("contenteditable"); */
/*     if (ce === "" || ce === "true") return true; */
/**/
/*     const tag = el.tagName?.toLowerCase(); */
/*     if (tag === "textarea") return true; */
/**/
/*     if (tag === "input") { */
/*         const t = (el as HTMLInputElement).type?.toLowerCase(); */
/*         if (!t) return true; */
/*         if ( */
/*             [ */
/*                 "text", */
/*                 "search", */
/*                 "url", */
/*                 "email", */
/*                 "password", */
/*                 "tel", */
/*                 "number", */
/*                 "date", */
/*                 "datetime-local", */
/*                 "month", */
/*                 "time", */
/*                 "week", */
/*             ].includes(t) */
/*         ) */
/*             return true; */
/*     } */
/**/
/*     if (el.getAttribute?.("role") === "textbox") return true; */
/*     return false; */
/* } */
/**/
/* ipcRenderer.on("pane:scroll", (_e, payload: { deltaY: number }) => { */
/*     if (isTypingContext()) return; */
/**/
/*     const dy = typeof payload?.deltaY === "number" ? payload.deltaY : 0; */
/*     if (!dy) return; */
/**/
/*     window.scrollBy(0, dy); */
/* }); */
/**/
/**/
/* const getTargets = () => { */
/*     const selectors = [ */
/*         'a[href]', */
/*         'button', */
/*         '[role="button"]', */
/*         'input:not([type="hidden"])', */
/*         'textarea', */
/*         'summary', */
/*         '[tabindex]:not([tabindex="-1"])' */
/*     ]; */
/**/
/*     const els = Array.from(document.querySelectorAll(selectors.join(','))) */
/*         .filter(el => { */
/*             const r = el.getBoundingClientRect(); */
/*             const style = window.getComputedStyle(el); */
/*             return r.width > 8 && r.height > 8 && style.visibility !== 'hidden' && style.display !== 'none'; */
/*         }); */
/**/
/*     return els.map(el => ({ */
/*         el, */
/*         rect: el.getBoundingClientRect(), */
/*         tag: el.tagName.toLowerCase(), */
/*         html: el.innerHTML, */
/*         href: (el as HTMLAnchorElement).href */
/*     })); */
/* }; */
/**/
/* ipcRenderer.on("pane:biscuits", (_e) => { */
/*     console.log("biscuits") */
/* }); */
