import chalk from "chalk";
import { isCancel, select, text } from "@clack/prompts";
import { AgentEngine, type UserContent } from "../../core/engine";
import type { PermissionMode } from "../../core/config";
import type { McpServerStatus } from "../../core/mcp";
import { printError } from "../../core/errors";
import { CliApprover, CliUI } from "../../tui/chat-ui";
import { BRAND_GRADIENT, box, changeBar, gradient, padEndVisible, prettyPath, sym, t } from "../../tui/theme";
import { fmtTokens } from "../../core/usage";
import { VERSION } from "../../core/version";
import { runApprovalFlow } from "./approval";
import { changeStats, composeBeforeAfter } from "./diff-view";
import { runSlash } from "./slash-commands";
import "./git-commands"; // registers /diff /commit /review /pr
import { buildUserContent, extractImageRefs } from "../../core/images";

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

// Image input: "@screenshots/bug.png", a dragged-in path, or "quoted path.png".
registerChatHooks({
    prepareInput(engine, input) {
        const { text, images, problems } = extractImageRefs(input, engine.root);
        for (const img of images)
            console.log(`  ${t.info("📎")} ${t.muted(`Attached ${img.name} (${Math.round(img.bytes / 1024)} KB)`)}`);
        for (const p of problems) console.log(t.warn(`  ${sym.warn} Couldn't attach ${p}`));
        return buildUserContent(text, images);
    },
});

function printHeader(engine: AgentEngine) {
    const mem = engine.memory.sources;
    const isAsk = engine.mode === "ask";
    const row = (k: string, v: string) => `${t.muted(k.padEnd(7))} ${v}`;
    const lines = [
        `${gradient(sym.star, BRAND_GRADIENT)} ${t.bold(isAsk ? "Ask anything about this codebase." : "What should we build today?")}`,
        "",
        row("model", t.brand(engine.modelSpec)),
        ...(isAsk
            ? [row("mode", `${t.read("read-only")} ${t.dim("· no edits, no commands")}`)]
            : [
                row(
                    "mode",
                    engine.permissionMode === "auto-edit"
                        ? `${t.warn("auto-edit")} ${t.dim("· edits written immediately, /undo reverts")}`
                        : `${t.ok("review")} ${t.dim("· you approve every diff · /mode to switch")}`,
                ),
            ]),
        row("folder", prettyPath(engine.root, 48)),
        row(
            "memory",
            mem.length
                ? mem.map((m) => m.path.split(/[\\/]/).pop()).join(", ")
                : t.dim(isAsk ? "none" : "none — /init creates RUSHCLAW.md"),
        ),
    ];
    const title = gradient(`RushClaw ${isAsk ? "Ask" : "Agent"}`, BRAND_GRADIENT, true) + t.dim(` v${VERSION}`);
    console.log("\n" + box(lines, { title, border: t.shadow, padding: 2 }));
    console.log(
        t.dim(`  ${["/help commands", "@file.png attach image", "\\ new line", "ctrl+c interrupt", "/exit leave"].join("  ·  ")}`) + "\n",
    );
}

const AGENT_TIPS = [
    "Describe a task, e.g. \"add input validation to the signup form\"",
    "Try: \"find and fix the failing test\"",
    "Attach a screenshot with @path/to/image.png",
    "Type /help to see all commands",
    "Try: \"explain how this project is structured\"",
    "Use /review before you commit",
];
const ASK_TIPS = [
    "Ask about the code, e.g. \"where is auth handled?\"",
    "Try: \"explain the data flow of a request\"",
    "Type /save to export this conversation",
];

function placeholderTip(engine: AgentEngine): string {
    const tips = engine.mode === "ask" ? ASK_TIPS : AGENT_TIPS;
    return tips[Math.floor(Math.random() * tips.length)]!;
}

/** Read one (possibly multi-line, via trailing "\") message from the user. */
async function readInput(engine: AgentEngine): Promise<string | null> {
    const lines: string[] = [];
    while (true) {
        const answer = await text({
            message: lines.length ? t.dim("…") : t.brand.bold("You"),
            placeholder: lines.length === 0 ? placeholderTip(engine) : undefined,
        });
        if (isCancel(answer)) return null;
        const line = String(answer ?? "");
        if (line.endsWith("\\")) {
            lines.push(line.slice(0, -1));
            continue;
        }
        lines.push(line);
        return lines.join("\n");
    }
}

/** Show staged changes and let the user approve / reject them (review mode). */
export async function reviewStagedChanges(engine: AgentEngine): Promise<number> {
    const pending = engine.pending();
    if (pending.length === 0) return 0;

    const byPath = new Map<string, typeof pending>();
    for (const a of pending) {
        const key = a.type === "tool_execute" ? `$ ${a.details.command}` : a.path;
        if (!byPath.has(key)) byPath.set(key, []);
        byPath.get(key)!.push(a);
    }
    const rows: Array<{ badge: string; path: string; added: number; removed: number; cmd?: boolean }> = [];
    for (const [p, acts] of byPath) {
        if (acts[0]!.type === "tool_execute") {
            rows.push({ badge: t.run("cmd "), path: p, added: 0, removed: 0, cmd: true });
            continue;
        }
        if (acts.every((a) => a.type === "folder_create")) {
            rows.push({ badge: t.info("dir "), path: p + "/", added: 0, removed: 0 });
            continue;
        }
        const sorted = [...acts].sort((x, y) => x.timestamp.getTime() - y.timestamp.getTime());
        const { before, after } = composeBeforeAfter(sorted);
        const { added, removed } = changeStats(before, after);
        const badge = sorted.some((a) => a.type === "file_delete")
            ? t.err("del ")
            : sorted[0]!.type === "file_create"
                ? t.ok("new ")
                : t.edit("edit");
        rows.push({ badge, path: p, added, removed });
    }
    const files = rows.filter((r) => !r.cmd).length;
    const maxTotal = Math.max(...rows.map((r) => r.added + r.removed), 1);
    const pathW = Math.min(48, Math.max(...rows.map((r) => r.path.length)));
    console.log(`\n${t.edit(sym.dot)} ${t.bold("Staged changes")} ${t.muted(`· ${files} file(s)${rows.length > files ? ` · ${rows.length - files} command(s)` : ""}`)}`);
    for (const r of rows) {
        const counts = r.cmd ? "" : `${t.ok(`+${r.added}`.padStart(5))} ${t.err(`-${r.removed}`.padEnd(5))} ${changeBar(r.added, r.removed, maxTotal)}`;
        console.log(`  ${r.badge}  ${padEndVisible(r.path.length > pathW ? "…" + r.path.slice(-(pathW - 1)) : r.path, pathW)}  ${counts}`);
    }
    console.log();

    await runApprovalFlow(engine.tracker);
    const res = engine.applyApproved();
    await engine.runPostApplyHooks(res.applied);
    if (res.applied.length)
        console.log(t.ok(`${sym.check} Applied ${res.applied.length} file change(s).`) + t.dim("  /undo to revert"));
    if (res.rejected.length) console.log(t.muted(`${sym.cross} Rejected: ${res.rejected.join(", ")}`));
    for (const out of res.shellOutputs) console.log(t.dim(out));
    for (const e of res.errors) console.log(t.err(`  ${sym.bullet} ${e}`));
    return res.applied.length;
}

export function printMcpStatus(status: McpServerStatus[]) {
    for (const s of status) {
        if (s.ok) console.log(`  ${t.mcp(sym.filled)} ${t.muted("MCP")} ${t.bold(s.name)} ${t.dim(`· ${s.tools.length} tool(s)`)}`);
        else console.log(`  ${t.err(sym.hollow)} ${t.muted("MCP")} ${t.bold(s.name)} ${t.err(`failed: ${s.error}`)}`);
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
    console.log(`${t.ok("↺")} ${t.bold("Resumed")} ${t.brand(`"${title}"`)} ${t.dim(`· ${turns} turn(s) · session ${engine.sessionId}`)}`);
    const lastAssistant = [...engine.messages].reverse().find((m) => m.role === "assistant");
    const text =
        typeof lastAssistant?.content === "string"
            ? lastAssistant.content
            : (lastAssistant?.content as any[] | undefined)?.find((p) => p?.type === "text")?.text;
    if (text) console.log(t.dim(`  ${sym.branch}  last reply: ${text.replace(/\s+/g, " ").slice(0, 160)}${text.length > 160 ? "…" : ""}`));
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
            console.log(t.warn(`${sym.warn} No saved session found — starting a new one.`));
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

    const stats = { turns: 0, files: 0, startedAt: Date.now() };

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
        stats.turns++;
        let interrupted = false;
        try {
            const r = await engine.runTurn(content, ac.signal);
            ui.turnEnd();
            interrupted = r.aborted;
            if (r.written.length) {
                stats.files += r.written.length;
                console.log(
                    t.ok(`${sym.check} Wrote ${r.written.length} file(s): ${r.written.join(", ")}`) +
                    t.dim("  /undo reverts this turn"),
                );
            }
        } catch (err) {
            ui.turnEnd();
            printError(err, engine.modelSpec);
        } finally {
            process.off("SIGINT", onSigint);
        }

        if (engine.mode === "agent") stats.files += await reviewStagedChanges(engine);
        for (const h of chatHooks) await h.afterTurn?.(engine, ui);
        ui.footer(engine.usage, { interrupted });
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
        printGoodbye(engine, stats);
    }
}

/** Session summary shown when the chat ends. */
function printGoodbye(engine: AgentEngine, stats: { turns: number; files: number; startedAt: number }) {
    console.log();
    if (stats.turns === 0) {
        console.log(t.dim("  Left the chat.\n"));
        return;
    }
    const mins = Math.max(1, Math.round((Date.now() - stats.startedAt) / 60000));
    const u = engine.usage.total;
    console.log(
        `  ${gradient(sym.star, BRAND_GRADIENT)} ${t.bold("Left the chat")} ${t.dim("·")} ${t.muted(
            `${stats.turns} turn(s) · ${stats.files} file change(s) · ${fmtTokens(u.input + u.output)} tokens · ~${mins} min`,
        )}`,
    );
    console.log(t.dim(`    resume with: rushclaw-build chat --resume ${engine.sessionId}\n`));
}
