import chalk from "chalk";

/**
 * RushClaw's terminal design system: one palette, gradient text, boxes,
 * progress bars, and a single switch that turns animations off.
 */

export const PALETTE = {
    violet: "#a78bfa",
    purple: "#c084fc",
    fuchsia: "#e879f9",
    pink: "#f472b6",
    shadow: "#5b4d9e",
    green: "#4ade80",
    amber: "#fbbf24",
    red: "#f87171",
    blue: "#60a5fa",
    cyan: "#67e8f9",
    teal: "#2dd4bf",
    gray: "#9ca3af",
} as const;

/** Brand gradient used for the banner, titles and the spinner. */
export const BRAND_GRADIENT = [PALETTE.violet, PALETTE.purple, PALETTE.fuchsia, PALETTE.pink];

export const t = {
    brand: chalk.hex(PALETTE.purple),
    accent: chalk.hex(PALETTE.pink),
    shadow: chalk.hex(PALETTE.shadow),
    ok: chalk.hex(PALETTE.green),
    warn: chalk.hex(PALETTE.amber),
    err: chalk.hex(PALETTE.red),
    info: chalk.hex(PALETTE.blue),
    read: chalk.hex(PALETTE.cyan),
    edit: chalk.hex(PALETTE.amber),
    run: chalk.hex(PALETTE.purple),
    agent: chalk.hex(PALETTE.pink),
    web: chalk.hex(PALETTE.blue),
    mcp: chalk.hex(PALETTE.teal),
    muted: chalk.hex(PALETTE.gray),
    dim: chalk.dim,
    bold: chalk.bold,
};

/** Unicode symbols, with ASCII fallbacks for legacy Windows consoles. */
export const fancy =
    process.env.RUSHCLAW_ASCII !== "1" &&
    (process.platform !== "win32" ||
        !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI || process.env.TERM));

export const sym = fancy
    ? {
        dot: "⏺",
        branch: "⎿",
        check: "✔",
        cross: "✘",
        warn: "▲",
        star: "✻",
        arrowUp: "↑",
        arrowDown: "↓",
        bullet: "•",
        todo: "◻",
        doing: "◼",
        done: "✔",
        filled: "●",
        hollow: "○",
        gitBranch: "⎇",
        barFull: "▰",
        barEmpty: "▱",
    }
    : {
        dot: "*",
        branch: "|_",
        check: "v",
        cross: "x",
        warn: "!",
        star: "*",
        arrowUp: "^",
        arrowDown: "v",
        bullet: "-",
        todo: "[ ]",
        doing: "[~]",
        done: "[x]",
        filled: "(*)",
        hollow: "( )",
        gitBranch: "@",
        barFull: "#",
        barEmpty: "-",
    };

/** Animations run only in an interactive terminal, outside CI, unless disabled. */
export function motionEnabled(): boolean {
    return (
        !!process.stdout.isTTY &&
        !process.env.CI &&
        process.env.RUSHCLAW_NO_ANIMATION !== "1" &&
        process.env.TERM !== "dumb"
    );
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ───────────────────────── text measurement ─────────────────────────

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
    return s.replace(ANSI_RE, "");
}

/** Display width: ANSI codes are ignored, emoji / wide CJK count as 2 columns. */
export function visibleWidth(s: string): number {
    let w = 0;
    for (const ch of stripAnsi(s)) {
        const cp = ch.codePointAt(0)!;
        if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector / joiner
        if (cp >= 0x1f300 || (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60))
            w += 2;
        else w += 1;
    }
    return w;
}

export function padEndVisible(s: string, width: number): string {
    return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

/** Cut to `width` columns (ANSI-aware enough for plain or single-colored text). */
export function truncateVisible(s: string, width: number): string {
    if (visibleWidth(s) <= width) return s;
    const plain = stripAnsi(s);
    let out = "";
    let w = 0;
    for (const ch of plain) {
        const cw = visibleWidth(ch);
        if (w + cw > width - 1) break;
        out += ch;
        w += cw;
    }
    return out + "…";
}

export function termWidth(): number {
    return Math.max(40, process.stdout.columns || 100);
}

// ───────────────────────── color ─────────────────────────

function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
    return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** Color at position `t` (0..1) along a multi-stop gradient. */
export function gradientAt(colors: readonly string[], pos: number): string {
    if (colors.length === 1) return colors[0]!;
    const p = Math.min(1, Math.max(0, pos)) * (colors.length - 1);
    const i = Math.min(colors.length - 2, Math.floor(p));
    const f = p - i;
    const a = hexToRgb(colors[i]!);
    const b = hexToRgb(colors[i + 1]!);
    return rgbToHex([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
}

/** Color each character of `text` along a horizontal gradient (spaces untouched). */
export function gradient(text: string, colors: readonly string[] = BRAND_GRADIENT, bold = false): string {
    const chars = [...text];
    const n = Math.max(1, chars.length - 1);
    return chars
        .map((ch, i) => {
            if (ch === " ") return ch;
            const c = chalk.hex(gradientAt(colors, i / n));
            return bold ? c.bold(ch) : c(ch);
        })
        .join("");
}

/**
 * Shimmer: `text` in a base color with a bright band centred on `pos`
 * (a character index). Animating `pos` makes the highlight sweep across.
 */
export function shimmer(text: string, pos: number, base = PALETTE.gray, bright = "#ffffff", radius = 3): string {
    return [...text]
        .map((ch, i) => {
            const d = Math.abs(i - pos);
            if (d > radius) return chalk.hex(base)(ch);
            const mix = 1 - d / (radius + 1);
            return chalk.hex(gradientAt([base, bright], mix))(ch);
        })
        .join("");
}

// ───────────────────────── layout ─────────────────────────

export interface BoxOptions {
    title?: string;
    /** Border color (chalk function). */
    border?: (s: string) => string;
    /** Total width including borders. Defaults to the content width (max terminal width). */
    width?: number;
    padding?: number;
}

/** Rounded box around lines of (possibly colored) text. */
export function box(lines: string[], opts: BoxOptions = {}): string {
    const border = opts.border ?? t.shadow;
    const pad = opts.padding ?? 1;
    const maxInner = termWidth() - 2 - pad * 2;
    const titleW = opts.title ? visibleWidth(opts.title) + 4 : 0;
    const contentW = Math.min(maxInner, Math.max(titleW, ...lines.map(visibleWidth)));
    const inner = opts.width ? Math.min(maxInner, opts.width - 2 - pad * 2) : contentW;
    const h = fancy ? { tl: "╭", tr: "╮", bl: "╰", br: "╯", x: "─", y: "│" } : { tl: "+", tr: "+", bl: "+", br: "+", x: "-", y: "|" };

    const fullW = inner + pad * 2;
    let top = h.tl + h.x.repeat(fullW) + h.tr;
    if (opts.title) {
        const title = ` ${opts.title} `;
        const rest = Math.max(0, fullW - 1 - visibleWidth(title));
        top = border(h.tl + h.x) + title + border(h.x.repeat(rest) + h.tr);
    } else top = border(top);

    const body = lines.map((l) => {
        const content = visibleWidth(l) > inner ? truncateVisible(l, inner) : l;
        return border(h.y) + " ".repeat(pad) + padEndVisible(content, inner) + " ".repeat(pad) + border(h.y);
    });
    return [top, ...body, border(h.bl + h.x.repeat(fullW) + h.br)].join("\n");
}

/** Word-wrap plain text to `width` columns (long words are split). */
export function wrap(text: string, width: number): string[] {
    const out: string[] = [];
    for (const para of text.split("\n")) {
        let line = "";
        for (const word of para.split(/\s+/).filter(Boolean)) {
            let w = word;
            while (visibleWidth(w) > width) {
                if (line) {
                    out.push(line);
                    line = "";
                }
                out.push(w.slice(0, width));
                w = w.slice(width);
            }
            if (!line) line = w;
            else if (visibleWidth(line) + 1 + visibleWidth(w) <= width) line += " " + w;
            else {
                out.push(line);
                line = w;
            }
        }
        out.push(line);
    }
    return out;
}

/** ▰▰▰▱▱ style progress bar. */
export function progressBar(done: number, total: number, width = 10, color: (s: string) => string = t.ok): string {
    if (total <= 0) return t.dim(sym.barEmpty.repeat(width));
    const filled = Math.round((done / total) * width);
    return color(sym.barFull.repeat(filled)) + t.dim(sym.barEmpty.repeat(width - filled));
}

/** git --stat style bar for added/removed lines. */
export function changeBar(added: number, removed: number, maxTotal: number, width = 12): string {
    const total = added + removed;
    if (total === 0) return "";
    const scale = Math.min(1, width / Math.max(maxTotal, 1));
    const a = Math.max(added ? 1 : 0, Math.round(added * scale));
    const r = Math.max(removed ? 1 : 0, Math.round(removed * scale));
    return t.ok("+".repeat(a)) + t.err("-".repeat(r));
}

/** Format milliseconds as "820ms" / "4.2s" / "1m 05s". */
export function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
}

/** Shorten a path for display: home → ~, long middles → …. */
export function prettyPath(p: string, max = 50): string {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    let s = home && p.toLowerCase().startsWith(home.toLowerCase()) ? "~" + p.slice(home.length) : p;
    s = s.replace(/\\/g, "/");
    if (s.length <= max) return s;
    return s.slice(0, 8) + "…" + s.slice(s.length - (max - 9));
}
