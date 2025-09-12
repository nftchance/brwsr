export function isLikelyUrl(s: string) {
    if (!s) return false;
    if (/\s/.test(s)) return false;
    const str = s.toLowerCase();

    if (/^[a-z][a-z0-9+\-.]*:\/\//.test(str)) return true;

    if (
        str === "localhost" ||
        str.startsWith("localhost:") ||
        str.startsWith("localhost/")
    )
        return true;

    if (/^\d{1,3}(\.\d{1,3}){3}/.test(str)) return true;

    if (/:[0-9]{2,5}(\/|$)/.test(str)) return true;

    if (/[a-z0-9-]\.[a-z]/i.test(str)) return true;

    return false;
}

export function normalizeUrlSmart(s: string) {
    const str = s.trim();

    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(str)) {
        return str;
    }

    const lower = str.toLowerCase();

    const isLocalHost =
        lower === "localhost" ||
        lower.startsWith("localhost:") ||
        lower.startsWith("localhost/");
    const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}/.test(lower);
    const hasPort = /:[0-9]{2,5}(\/|$)?/.test(lower);

    const scheme = isLocalHost || isIPv4 || hasPort ? "http" : "https";

    return `${scheme}://${str}`;
}
