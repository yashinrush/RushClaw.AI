import chalk from "chalk";
import { isCancel, select } from "@clack/prompts";
import type { EngineUI } from "../core/engine";
import type { Approver, PermissionAnswer, PermissionRequest } from "../core/permissions";
import type { UsageTracker } from "../core/usage";
import { fmtTokens } from "../core/usage";
import { Activity, randomVerb } from "./activity";
import { StreamingMarkdown } from "./stream-md";
import { printToolCall, printToolError, printToolResult, toolLabel } from "./tool-display";
import { formatTodos, type Todo } from "../core/todos";
import { BRAND_GRADIENT, box, fmtDuration, gradient, gradientAt, sym, t } from "./theme";

/** Indent a rendered Markdown block; the first block of a reply gets the brand marker. */
export function decorateReply(rendered: string, first: boolean): string {
    const lines = rendered.replace(/^\n+/, "").replace(/\n+$/, "").split("\n");
    const marker = chalk.hex(gradientAt(BRAND_GRADIENT, 0.5))(sym.dot) + " ";
    return lines.map((l, i) => (i === 0 && first ? marker : "  ") + l).join("\n") + "\n\n";
}

/** Terminal implementation of the engine's progress callbacks. */
export class CliUI implements EngineUI {
    readonly activity = new Activity();
    private label = "Thinking…";
    private verb = "Thinking";
    private replyStarted = false;
    private toolStarts: Array<{ name: string; at: number }> = [];
    private readonly md = new StreamingMarkdown((s) => {
        const wasRunning = this.activity.running;
        this.activity.stop();
        process.stdout.write(decorateReply(s, !this.replyStarted));
        this.replyStarted = true;
        if (wasRunning) this.activity.start(this.label);
    });

    turnStart(): void {
        console.log();
        this.verb = randomVerb();
        this.replyStarted = false;
        this.toolStarts = [];
        this.activity.reset();
        this.setLabel(`${this.verb}…`);
        this.activity.start(this.label);
    }

    turnEnd(): void {
        this.md.flush();
        this.activity.stop();
    }

    /** "✻ Done in 8.2s · ↑ 11k ↓ 113 · 4 calls · context 2.9k" */
    footer(usage: UsageTracker, opts: { interrupted?: boolean } = {}): void {
        const d = usage.turnDelta();
        const time = fmtDuration(this.activity.elapsedMs);
        const head = opts.interrupted
            ? t.warn(`${sym.cross} Interrupted after ${time}`)
            : `${gradient(sym.star, BRAND_GRADIENT)} ${t.muted(`Done in ${time}`)}`;
        const stats = [
            `${sym.arrowUp} ${fmtTokens(d.input)}`,
            `${sym.arrowDown} ${fmtTokens(d.output)}`,
            `${d.calls} call${d.calls === 1 ? "" : "s"}`,
            `context ${fmtTokens(usage.lastInputTokens)}`,
        ].join(" · ");
        console.log(`${head} ${t.dim("·")} ${t.dim(stats)}`);
    }

    private setLabel(l: string) {
        this.label = l;
        this.activity.set(l);
    }

    text(delta: string): void {
        this.activity.addOutput(delta.length);
        this.setLabel("Writing…");
        this.md.push(delta);
    }

    textDone(): void {
        this.md.flush();
    }

    toolCall(name: string, input: unknown): void {
        this.md.flush();
        this.activity.stop();
        this.replyStarted = false; // text after tools starts a new block with a marker
        printToolCall(name, input);
        this.toolStarts.push({ name, at: Date.now() });
        this.setLabel(`${toolLabel(name, input)}…`);
        this.activity.start(this.label);
    }

    private took(name: string): number | undefined {
        const i = this.toolStarts.findIndex((s) => s.name === name);
        if (i < 0) return undefined;
        const [s] = this.toolStarts.splice(i, 1);
        return Date.now() - s!.at;
    }

    toolResult(name: string, output: unknown, input?: unknown): void {
        this.activity.stop();
        printToolResult(name, output, input, this.took(name));
        this.setLabel(`${this.verb}…`);
        this.activity.start(this.label);
    }

    toolError(name: string, error: unknown): void {
        this.activity.stop();
        this.took(name);
        printToolError(name, error);
        this.setLabel(`${this.verb}…`);
        this.activity.start(this.label);
    }

    todos(todos: Todo[]): void {
        const wasRunning = this.activity.running;
        this.activity.stop();
        console.log(formatTodos(todos));
        if (wasRunning) this.activity.start(this.label);
    }

    subagentStep(task: string, action: string): void {
        const wasRunning = this.activity.running;
        this.activity.stop();
        console.log(`     ${t.agent("↳")} ${t.dim(action)}`);
        this.setLabel(`Sub-agent · ${task}…`);
        if (wasRunning) this.activity.start(this.label);
    }

    info(message: string): void {
        const wasRunning = this.activity.running;
        this.activity.stop();
        console.log(t.warn(`${sym.warn} ${message}`));
        if (wasRunning) this.activity.start(this.label);
    }

    /** Pause the spinner around an interactive prompt. */
    async pauseFor<T>(fn: () => Promise<T>): Promise<T> {
        const wasRunning = this.activity.running;
        this.activity.stop();
        try {
            return await fn();
        } finally {
            if (wasRunning) this.activity.start(this.label);
        }
    }
}

/** Asks the user (mid-turn) before running a command outside the allowlist or an MCP tool. */
export class CliApprover implements Approver {
    constructor(private readonly ui?: CliUI) { }

    async ask(req: PermissionRequest): Promise<PermissionAnswer> {
        const run = async (): Promise<PermissionAnswer> => {
            const detail = req.detail.split("\n").slice(0, 12);
            const body = req.kind === "command" ? detail.map((l, i) => (i === 0 ? t.run("$ ") : "  ") + l) : detail.map((l) => t.mcp(l));
            console.log("\n" + box(body, { title: t.warn.bold(req.title), border: t.warn }));
            const choice = await select<PermissionAnswer>({
                message: "Allow?",
                options: [
                    { value: "yes", label: "Yes" },
                    { value: "always", label: `Yes, and don't ask again for ${req.alwaysLabel} this session` },
                    { value: "no", label: "No", hint: "the agent will continue without it" },
                ],
            });
            return isCancel(choice) ? "no" : choice;
        };
        return this.ui ? this.ui.pauseFor(run) : run();
    }
}
