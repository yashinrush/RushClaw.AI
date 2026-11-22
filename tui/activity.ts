import { BRAND_GRADIENT, fancy, fmtDuration, gradientAt, motionEnabled, shimmer, sym, t } from "./theme";
import chalk from "chalk";
import { fmtTokens } from "../core/usage";

const FRAMES = fancy ? ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"] : ["-", "\\", "|", "/"];
const TICK_MS = 80;

/** Playful verbs for the "thinking" state, picked per turn. */
export const THINKING_VERBS = [
    "Thinking",
    "Rushing",
    "Clawing through code",
    "Pondering",
    "Scheming",
    "Untangling",
    "Brewing",
    "Sketching",
    "Connecting dots",
    "Reasoning",
];

export function randomVerb(): string {
    return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)]!;
}

/**
 * A one-line animated status: spinning star, shimmering label, elapsed time,
 * live output-token estimate and the interrupt hint. It can be stopped
 * instantly before any other output, so it never collides with streamed text
 * or prompts.
 */
export class Activity {
    private timer: ReturnType<typeof setInterval> | null = null;
    private frame = 0;
    private label = "";
    private started = 0;
    private tokens = 0;
    private readonly enabled = motionEnabled();

    start(label: string): void {
        this.label = label;
        if (!this.enabled || this.timer) return;
        if (!this.started) this.started = Date.now();
        this.render();
        this.timer = setInterval(() => this.render(), TICK_MS);
    }

    set(label: string): void {
        this.label = label;
    }

    /** Add streamed output (≈ 4 characters per token) to the live counter. */
    addOutput(chars: number): void {
        this.tokens += chars / 4;
    }

    /** Begin timing a new turn. */
    reset(): void {
        this.started = Date.now();
        this.tokens = 0;
    }

    get elapsedMs(): number {
        return this.started ? Date.now() - this.started : 0;
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        process.stdout.write("\r\x1b[2K");
    }

    get running(): boolean {
        return this.timer !== null;
    }

    /** The status line for the current frame (exported for tests). */
    line(): string {
        const f = this.frame;
        const star = chalk.hex(gradientAt(BRAND_GRADIENT, (f % 20) / 19))(FRAMES[f % FRAMES.length]!);
        const width = [...this.label].length;
        const pos = (f * 0.6) % (width + 8) - 4;
        const label = shimmer(this.label, pos);
        const secs = this.elapsedMs;
        const extras: string[] = [];
        if (secs >= 1000) extras.push(fmtDuration(Math.round(secs / 100) * 100));
        if (this.tokens >= 1) extras.push(`${sym.arrowDown} ${fmtTokens(Math.round(this.tokens))} tokens`);
        if (secs >= 2000) extras.push("ctrl+c to interrupt");
        return `${star} ${label}${extras.length ? t.dim(` (${extras.join(" · ")})`) : ""}`;
    }

    private render(): void {
        this.frame++;
        const cols = process.stdout.columns || 100;
        let l = this.line();
        // never wrap: a wrapped status line can't be cleared with \r
        if ([...l.replace(/\x1b\[[0-9;]*m/g, "")].length >= cols) l = `${FRAMES[this.frame % FRAMES.length]} ${this.label.slice(0, cols - 4)}`;
        process.stdout.write(`\r\x1b[2K${l}`);
    }
}
