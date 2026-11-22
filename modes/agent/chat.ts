import chalk from "chalk";
import { isCancel, select, text } from "@clack/prompts";
import { AgentEngine, type UserContent } from "../../core/engine";
import type { PermissionMode } from "../../core/config";
import type { McpServerStatus } from "../../core/mcp";
import { printError } from "../../core/errors";
import { CliApprover, CliUI } from "../../tui/chat-ui";
import { runApprovalFlow } from "./approval";
import { changeStats, composeBeforeAfter } from "./diff-view";
import { runSlash } from "./slash-commands";

export interface ChatOptions {
    /** "agent" (default) can edit files and run commands; "ask" is read-only Q&A. */
    mode?: "agent" | "ask";
    model?: string;
    permissionMode?: PermissionMode;
    /** Run this prompt (or /command) first, e.g. from `rushclaw chat "fix the build"`. */
    initialPrompt?: string;
    /** Continue the most recent session of this mode. */
    continueLast?: boolean;
    /** Resume a specific session id, or `true` to pick from a list. */
    resume?: string | boolean;
}

/** Hooks other modules use to extend the chat (sessions, MCP, images…). */
export interface ChatHooks {
    /** Called once after the engine is created. */
    setup?(engine: AgentEngine, ui: CliUI): Promise<void> | void;
    /** Turn raw input into model content (e.g. attach @image references). */
    prepareInput?(engine: AgentEngine, input: string): Promise<string | UserContent> | string | UserContent;
    /** After every completed turn. */
    afterTurn?(engine: AgentEngine, ui: CliUI): Promise<void> | void;
    /** When the chat ends. */
    teardown?(engine: AgentEngine): Promise<void> | void;
}

const chatHooks: ChatHooks[] = [];

export function registerChatHooks(h: ChatHooks): void {
    chatHooks.push(h);
}

function printHeader(engine: AgentEngine) {
    const mem = engine.memory.sources;
    const title = engine.mode === "ask" ? "Ask mode (read-only)" : "Agent chat";
    console.log(
        [
            "",
            `${chalk.magenta("╭")} ${chalk.bold(`RushClaw · ${title}`)}`,
            `${chalk.magenta("│")} model  ${chalk.cyan(engine.modelSpec)}${engine.mode === "agent" ? `   mode ${chalk.cyan(engine.permissionMode)}` : ""}`,
            `${chalk.magenta("│")} cwd    ${engine.root}`,
            `${chalk.magenta("│")} memory ${mem.length ? mem.map((s) => s.path.split(/[\\/]/).pop()).join(", ") : chalk.dim(engine.mode === "agent" ? "none — run /init to create RUSHCLAW.md" : "none")}`,
            `${chalk.magenta("╰")} ${chalk.dim("/help for commands · Ctrl+C interrupts a turn · /exit to leave")}`,
            "",
        ].join("\n"),
    );
}

/** Read one (possibly multi-line, via trailing "\") message from the user. */
async function readInput(engine: AgentEngine): Promise<string | null> {
    const lines: string[] = [];
    while (true) {
        const t = await text({
            message: lines.length ? chalk.dim("…") : chalk.bold("You"),
            placeholder:
                lines.length === 0
                    ? engine.mode === "ask"
                        ? "Ask about the codebase (or /help)"
                        : "Describe a task or ask a question (/help for commands)"
                    : undefined,
        });
        if (isCancel(t)) return null;
        const line = String(t ?? "");
        if (line.endsWith("\\")) {
            lines.push(line.slice(0, -1));
            continue;
        }
        lines.push(line);
        return lines.join("\n");
    }
}

/** Show staged changes and let the user approve / reject them (review mode). */
export async function reviewStagedChanges(engine: AgentEngine): Promise<void> {
    const pending = engine.pending();
    if (pending.length === 0) return;

    console.log(chalk.bold("\n📝 Staged changes"));
    const byPath = new Map<string, typeof pending>();
    for (const a of pending) {
        const key = a.type === "tool_execute" ? `$ ${a.details.command}` : a.path;
        if (!byPath.has(key)) byPath.set(key, []);
        byPath.get(key)!.push(a);
    }
    for (const [p, acts] of byPath) {
        if (acts[0]!.type === "tool_execute") {
            console.log(`  ${chalk.yellow("cmd")}  ${p}`);
            continue;
        }
        if (acts.every((a) => a.type === "folder_create")) {
            console.log(`  ${chalk.cyan("dir")}  ${p}/`);
            continue;
        }
        const sorted = [...acts].sort((x, y) => x.timestamp.getTime() - y.timestamp.getTime());
        const { before, after } = composeBeforeAfter(sorted);
        const { added, removed } = changeStats(before, after);
        const kind = sorted.some((a) => a.type === "file_delete") ? chalk.red("del ") : sorted[0]!.type === "file_create" ? chalk.green("new ") : chalk.blue("edit");
        console.log(`  ${kind} ${p} ${chalk.green(`+${added}`)} ${chalk.red(`-${removed}`)}`);
    }
    console.log();

    await runApprovalFlow(engine.tracker);
    const res = engine.applyApproved();
    await engine.runPostApplyHooks(res.applied);
    if (res.applied.length)
        console.log(chalk.green(`✓ Applied ${res.applied.length} file change(s).`) + chalk.dim("  (/undo to revert)"));
    if (res.rejected.length) console.log(chalk.dim(`✗ Rejected: ${res.rejected.join(", ")}`));
    for (const out of res.shellOutputs) console.log(chalk.dim(out));
    for (const e of res.errors) console.log(chalk.red(`  • ${e}`));
}

export function printMcpStatus(status: McpServerStatus[]) {
    for (const s of status) {
        if (s.ok) console.log(`${chalk.green("🔌")} MCP ${chalk.bold(s.name)} ${chalk.dim(`· ${s.tools.length} tool(s)`)}`);
        else console.log(`${chalk.red("🔌")} MCP ${chalk.bold(s.name)} ${chalk.red(`failed: ${s.error}`)}`);
    }
    if (status.length) console.log();
}

/** Interactive list of saved sessions for this project. */
export async function pickSession(engine: AgentEngine) {
    const list = engine.sessions.list().filter((s) => s.mode === engine.mode);
    if (!list.length) {
        console.log(chalk.dim("No saved sessions for this project yet."));
        return null;
    }
    const id = await select({
        message: "Resume which conversation?",
        options: list.slice(0, 25).map((s) => ({
            value: s.id,
            label: s.title,
            hint: `${s.updatedAt.replace("T", " ").slice(0, 16)} · ${s.turns} turn(s)`,
        })),
    });
    if (isCancel(id)) return null;
    return engine.sessions.load(id as string);
}

export function printResumed(engine: AgentEngine, title: string) {
    const turns = engine.messages.filter((m) => m.role === "user").length;
    console.log(chalk.green(`↺ Resumed "${title}" (${turns} turn(s), session ${engine.sessionId})`));
    const lastAssistant = [...engine.messages].reverse().find((m) => m.role === "assistant");
    const text =
        typeof lastAssistant?.content === "string"
            ? lastAssistant.content
            : (lastAssistant?.content as any[] | undefined)?.find((p) => p?.type === "text")?.text;
    if (text) console.log(chalk.dim(`  Last reply: ${text.replace(/\s+/g, " ").slice(0, 160)}${text.length > 160 ? "…" : ""}`));
}

export async function runChat(opts: ChatOptions = {}): Promise<void> {
    const ui = new CliUI();
    const engine = new AgentEngine({
        mode: opts.mode ?? "agent",
        model: opts.model,
        permissionMode: opts.permissionMode,
        approver: new CliApprover(ui),
        ui,
        persist: true,
    });
    if (opts.continueLast || opts.resume) {
        const data =
            typeof opts.resume === "string"
                ? engine.sessions.load(opts.resume)
                : opts.resume
                    ? await pickSession(engine)
                    : engine.sessions.latest(engine.mode);
        if (data) {
            engine.loadSession(data);
            if (opts.model) engine.setModel(opts.model);
            if (opts.permissionMode) engine.setPermissionMode(opts.permissionMode);
            printResumed(engine, data.title);
        } else if (opts.resume !== true) {
            console.log(chalk.yellow("No saved session found — starting a new one."));
        }
    }
    for (const h of chatHooks) await h.setup?.(engine, ui);
    printHeader(engine);
    if (Object.keys(engine.config.mcpServers).length && engine.mode === "agent") {
        ui.activity.start("Connecting MCP servers…");
        const status = await engine.connectMcp();
        ui.activity.stop();
        printMcpStatus(status);
    }

    const runPrompt = async (prompt: string) => {
        let content: string | UserContent = prompt;
        for (const h of chatHooks) if (h.prepareInput) content = await h.prepareInput(engine, typeof content === "string" ? content : prompt);

        const ac = new AbortController();
        const onSigint = () => {
            if (!ac.signal.aborted) {
                ac.abort();
                ui.info("Interrupting…");
            }
        };
        process.on("SIGINT", onSigint);
        ui.turnStart();
        try {
            const r = await engine.runTurn(content, ac.signal);
            ui.turnEnd();
            if (r.aborted) console.log(chalk.yellow("⏹  Interrupted."));
            if (r.written.length)
                console.log(
                    chalk.green(`\n✓ Wrote ${r.written.length} file(s): ${r.written.join(", ")}`) +
                    chalk.dim("  (/undo to revert this turn)"),
                );
        } catch (err) {
            ui.turnEnd();
            printError(err, engine.modelSpec);
        } finally {
            process.off("SIGINT", onSigint);
        }

        if (engine.mode === "agent") await reviewStagedChanges(engine);
        for (const h of chatHooks) await h.afterTurn?.(engine, ui);
        console.log(chalk.dim(`  ↳ ${engine.usage.formatTurn()}`));
    };

    const handle = async (line: string): Promise<"exit" | void> => {
        if (line.startsWith("/")) return runSlash(line, { engine, runPrompt });
        await runPrompt(line);
    };

    try {
        if (opts.initialPrompt?.trim() && (await handle(opts.initialPrompt.trim())) === "exit") return;
        while (true) {
            const input = await readInput(engine);
            if (input === null) break;
            const line = input.trim();
            if (!line) continue;
            if ((await handle(line)) === "exit") break;
        }
    } finally {
        if (engine.pending().length) engine.rejectAll();
        for (const h of chatHooks) await h.teardown?.(engine);
        await engine.close();
        console.log(chalk.dim("\nLeft the chat.\n"));
    }
}
