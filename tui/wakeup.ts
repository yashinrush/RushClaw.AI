import fs from "node:fs";
import path from "node:path";
import { select, isCancel } from "@clack/prompts";
import chalk from "chalk";
import figlet from "figlet";
import { runTelegramMode } from "../modes/telegram";
import { runAgentMode } from "../modes/agent/orchestrator";
import { runAskMode } from "../modes/ask/orchestrator";
import { runPlanMode } from "../modes/plan/orchestrator";
import { defaultModelSpec, hasProviderKey } from "../ai/ai.config";
import { loadConfig } from "../core/config";
import { SessionStore } from "../core/session";
import { VERSION } from "../core/version";
import {
    BRAND_GRADIENT,
    PALETTE,
    gradient,
    gradientAt,
    motionEnabled,
    prettyPath,
    sleep,
    sym,
    t,
    termWidth,
} from "./theme";

const SOLID = new Set(["█", "▀", "▄", "▌", "▐", "■"]);
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Pick the largest banner font that fits the terminal. */
export function bannerLines(width = termWidth()): string[] {
    for (const font of ["ANSI Shadow", "Standard", "Small"] as const) {
        try {
            const lines = figlet.textSync("rushclaw", { font }).replace(/\s+$/, "").split("\n");
            if (Math.max(...lines.map((l) => l.length)) + 4 <= width) return lines;
        } catch { }
    }
    return ["RUSHCLAW"];
}

export interface BannerFrame {
    /** Columns revealed so far (left to right). */
    reveal?: number;
    /** Centre column of the diagonal light sweep. */
    shine?: number;
}

/**
 * Color one banner row: solid blocks get the brand gradient (diagonal), the
 * font's box-drawing "shadow" glyphs get the shadow color, and an optional
 * bright band sweeps across.
 */
export function colorBannerRow(line: string, row: number, rows: number, width: number, frame: BannerFrame = {}): string {
    let out = "";
    const chars = [...line];
    for (let c = 0; c < chars.length; c++) {
        const ch = chars[c]!;
        if (frame.reveal !== undefined && c >= frame.reveal) {
            out += " ";
            continue;
        }
        if (ch === " ") {
            out += ch;
            continue;
        }
        let color = SOLID.has(ch)
            ? gradientAt(BRAND_GRADIENT, (c + row * 2) / (width + rows * 2))
            : PALETTE.shadow;
        if (frame.shine !== undefined) {
            const d = Math.abs(c - row - frame.shine);
            if (d < 4) color = gradientAt([color, "#ffffff"], (1 - d / 4) * (SOLID.has(ch) ? 0.85 : 0.5));
        }
        out += chalk.hex(color)(ch);
    }
    return out;
}

async function animateBanner(lines: string[]) {
    const rows = lines.length;
    const width = Math.max(...lines.map((l) => l.length));
    const tty = !!process.stdout.isTTY;
    const draw = (frame: BannerFrame, first = false) => {
        if (!first) process.stdout.write(`\x1b[${rows}A`);
        for (let r = 0; r < rows; r++)
            process.stdout.write((tty ? "\r\x1b[2K" : "") + "  " + colorBannerRow(lines[r]!, r, rows, width, frame) + "\n");
    };

    if (!motionEnabled()) {
        draw({}, true);
        return;
    }
    process.stdout.write(HIDE_CURSOR);
    const restore = () => process.stdout.write(SHOW_CURSOR);
    process.once("exit", restore);
    try {
        draw({ reveal: 0 }, true);
        const revealSteps = 12;
        for (let i = 1; i <= revealSteps; i++) {
            draw({ reveal: Math.ceil((width / revealSteps) * i) });
            await sleep(16);
        }
        for (let s = -6; s <= width + rows + 6; s += 4) {
            draw({ shine: s });
            await sleep(14);
        }
        draw({});
    } finally {
        restore();
        process.removeListener("exit", restore);
    }
}

async function typewriter(text: string, msPerChar = 4) {
    if (!motionEnabled()) {
        process.stdout.write(text + "\n");
        return;
    }
    // type the plain text, then repaint it with colors
    const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
    for (const ch of plain) {
        process.stdout.write(t.muted(ch));
        await sleep(msPerChar);
    }
    process.stdout.write("\r\x1b[2K" + text + "\n");
}

function gitBranch(root: string): string | null {
    try {
        const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
        return head.startsWith("ref: refs/heads/") ? head.slice(16) : head.slice(0, 8);
    } catch {
        return null;
    }
}

/** "● Gemini ● OpenRouter ○ Firecrawl ● Telegram" — which integrations are configured. */
export function statusLine(): string {
    const chip = (on: boolean, label: string) => (on ? t.ok(sym.filled) + " " + label : t.dim(sym.hollow + " " + label));
    return [
        chip(hasProviderKey("gemini"), "Gemini"),
        chip(hasProviderKey("openrouter"), "OpenRouter"),
        chip(!!process.env.FIRECRAWL_API_KEY?.trim(), "Firecrawl"),
        chip(!!(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_OWNER_ID?.trim()), "Telegram"),
    ].join("   ");
}

export async function printBanner(): Promise<void> {
    console.log();
    await animateBanner(bannerLines());
    await typewriter(
        `  ${gradient("autonomous coding agent for your terminal", BRAND_GRADIENT)}  ${t.dim("·")}  ${t.muted("v" + VERSION)}`,
    );
    const root = process.cwd();
    const branch = gitBranch(root);
    console.log();
    console.log(`  ${statusLine()}`);
    console.log(
        `  ${t.muted("model")} ${t.brand(defaultModelSpec(loadConfig(root).model))}   ${t.muted("folder")} ${prettyPath(root, 40)}${branch ? `  ${t.muted(sym.gitBranch)} ${t.info(branch)}` : ""}`,
    );
    if (!hasProviderKey("gemini") && !hasProviderKey("openrouter"))
        console.log(t.warn(`\n  ${sym.warn} No API key found — add GEMINI_API_KEY or OPENROUTER_API_KEY to .env`));
    console.log();
}

export async function runWakeup() {
    await printBanner();

    while (true) {
        const saved = new SessionStore(process.cwd()).list().length;
        const mode = await select({
            message: gradient("What would you like to do?", BRAND_GRADIENT, true),
            options: [
                { value: "agent", label: "💬 Agent chat", hint: "edit code, run checks, multi-turn" },
                { value: "plan", label: "🧭 Plan", hint: "research → step plan → execute" },
                { value: "ask", label: "❓ Ask", hint: "read-only questions about this codebase" },
                ...(saved
                    ? [{ value: "resume", label: "↺  Resume a conversation", hint: `${saved} saved in this folder` }]
                    : []),
                { value: "telegram", label: "📱 Telegram bot", hint: "control RushClaw from your phone" },
                { value: "exit", label: "✕  Exit" },
            ],
        });
        if (isCancel(mode) || mode === "exit") {
            console.log(`\n  ${gradient("See you soon!", BRAND_GRADIENT)} ${t.dim("— rushclaw")}\n`);
            return;
        }

        if (mode === "agent") await runAgentMode();
        else if (mode === "ask") await runAskMode();
        else if (mode === "plan") await runPlanMode();
        else if (mode === "resume") await runAgentMode({ resume: true });
        else if (mode === "telegram") await runTelegramMode();
    }
}
