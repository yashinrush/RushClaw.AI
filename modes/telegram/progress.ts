import type { Context } from "telegraf";
import type { EngineUI } from "../../core/engine";
import { toolLabel } from "../../tui/tool-display";
import { clip } from "./text";

const EDIT_INTERVAL_MS = 1500;
const MAX_LINES = 14;

/**
 * One Telegram message that is edited in place as the agent works (instead of
 * spamming the chat). Edits are throttled to stay under Telegram's rate limits.
 */
export class TelegramProgress {
    private lines: string[] = [];
    private messageId?: number;
    private lastEdit = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastText = "";
    readonly startedAt = Date.now();

    constructor(
        private readonly ctx: Context,
        private readonly title: string,
    ) { }

    async start(): Promise<void> {
        const m = await this.ctx.reply(`${this.title}\n⏳ working…`);
        this.messageId = m.message_id;
    }

    log(line: string): void {
        this.lines.push(line);
        if (this.lines.length > MAX_LINES) this.lines = this.lines.slice(-MAX_LINES);
        this.schedule();
    }

    private schedule(): void {
        if (this.timer) return;
        const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastEdit));
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.render("⏳ working…");
        }, wait);
    }

    private async render(footer: string): Promise<void> {
        const chatId = this.ctx.chat?.id;
        if (!this.messageId || chatId === undefined) return;
        const secs = Math.round((Date.now() - this.startedAt) / 1000);
        const text = clip([this.title, ...this.lines, `${footer} (${secs}s)`].join("\n"), 4000);
        if (text === this.lastText) return;
        this.lastEdit = Date.now();
        this.lastText = text;
        try {
            await this.ctx.telegram.editMessageText(chatId, this.messageId, undefined, text);
        } catch {
            // "message is not modified" / rate limits — progress is best-effort
        }
    }

    async done(footer: string): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        await this.render(footer);
    }

    /** Engine callbacks that feed this progress message. */
    ui(): EngineUI {
        return {
            toolCall: (n, i) => this.log(`⏺ ${toolLabel(n, i)}`),
            toolError: (_n, e) => this.log(`  ⚠️ ${clip((e as Error)?.message ?? String(e), 120)}`),
            todos: (t) => {
                const current = t.find((x) => x.status === "in_progress");
                const done = t.filter((x) => x.status === "completed").length;
                this.log(`📋 ${done}/${t.length} done${current ? ` · now: ${current.content}` : ""}`);
            },
            subagentStep: (_t, a) => this.log(`   ↳ ${a}`),
            info: (m) => this.log(`⚠️ ${m}`),
        };
    }

    elapsed(): string {
        const s = Math.round((Date.now() - this.startedAt) / 1000);
        return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
    }
}
