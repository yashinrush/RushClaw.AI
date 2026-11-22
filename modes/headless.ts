import chalk from "chalk";
import { AgentEngine } from "../core/engine";
import { errorText } from "../core/errors";
import { buildUserContent, extractImageRefs } from "../core/images";
import { composeBeforeAfter, formatPatch } from "./agent/diff-view";
import { toolLabel, resultSummary } from "../tui/tool-display";

export interface HeadlessOptions {
    prompt: string;
    /** Apply edits (auto-edit mode). Without it, changes are only shown, never written. */
    yes?: boolean;
    output?: "text" | "json";
    model?: string;
    maxSteps?: number;
    continueLast?: boolean;
    /** Read-only (Ask mode tools). */
    readOnly?: boolean;
    /** Append piped stdin to the prompt. */
    stdin?: boolean;
}

async function readStdin(): Promise<string> {
    if (process.stdin.isTTY) return "";
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
}

const err = (s: string) => process.stderr.write(s + "\n");

/**
 * `rushclaw-build -p "<task>"`: one non-interactive turn for scripts and CI.
 * Streams the answer to stdout (tool activity to stderr), or prints one JSON
 * object with --output json. Returns the process exit code.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
    const json = opts.output === "json";
    let prompt = opts.prompt;
    if (prompt === "-" || opts.stdin) {
        const input = await readStdin();
        prompt = prompt === "-" ? input : `${prompt}\n\n<stdin>\n${input}\n</stdin>`;
    }
    if (!prompt.trim()) {
        err("rushclaw: empty prompt");
        return 2;
    }

    const engine = new AgentEngine({
        mode: opts.readOnly ? "ask" : "agent",
        model: opts.model,
        permissionMode: opts.yes ? "auto-edit" : "review",
        persist: true,
        ui: json
            ? {}
            : {
                text: (d) => process.stdout.write(d),
                textDone: () => { },
                toolCall: (n, i) => err(chalk.dim(`⏺ ${toolLabel(n, i)}`)),
                toolResult: (n, o) => err(chalk.dim(`  ⎿  ${resultSummary(n, o)}`)),
                toolError: (n, e) => err(chalk.red(`  ⎿  ${(e as Error)?.message ?? String(e)}`)),
                info: (m) => err(chalk.yellow(`⚠️  ${m}`)),
                subagentStep: (_t, a) => err(chalk.dim(`  ⎿  ↳ ${a}`)),
            },
    });
    if (opts.maxSteps) engine.config.maxSteps = opts.maxSteps;
    if (opts.continueLast) {
        const last = engine.sessions.latest(engine.mode);
        if (last) {
            engine.loadSession(last);
            if (opts.model) engine.setModel(opts.model);
            engine.setPermissionMode(opts.yes ? "auto-edit" : "review");
        }
    }

    if (Object.keys(engine.config.mcpServers).length && !opts.readOnly) {
        const status = await engine.connectMcp();
        for (const s of status) if (!s.ok && !json) err(chalk.yellow(`⚠️  MCP ${s.name}: ${s.error}`));
    }

    const { text, images, problems } = extractImageRefs(prompt, engine.root);
    for (const p of problems) if (!json) err(chalk.yellow(`⚠️  Couldn't attach ${p}`));

    let exitCode = 0;
    let resultText = "";
    let written: string[] = [];
    let error: string | null = null;
    try {
        const r = await engine.runTurn(buildUserContent(text, images));
        resultText = r.text;
        written = r.written;
        if (!json && !r.text.endsWith("\n")) process.stdout.write("\n");
    } catch (e) {
        error = errorText(e, engine.modelSpec);
        exitCode = 1;
    }

    // Without --yes nothing is written: report the staged diffs instead.
    const pending = engine.pending();
    const byPath = new Map<string, typeof pending>();
    const queuedCommands: string[] = [];
    for (const a of pending) {
        if (a.type === "tool_execute") {
            queuedCommands.push(a.details.command ?? "");
            continue;
        }
        if (!byPath.has(a.path)) byPath.set(a.path, []);
        byPath.get(a.path)!.push(a);
    }
    const staged = [...byPath].map(([p, acts]) => {
        const sorted = [...acts].sort((x, y) => x.timestamp.getTime() - y.timestamp.getTime());
        if (sorted.every((a) => a.type === "folder_create")) return { path: p, type: "folder_create", diff: "" };
        const { before, after } = composeBeforeAfter(sorted);
        return { path: p, type: sorted[sorted.length - 1]!.type, diff: formatPatch(p, before, after) };
    });
    if (pending.length) engine.rejectAll();
    await engine.close();

    const usage = engine.usage.turnDelta();
    if (json) {
        process.stdout.write(
            JSON.stringify(
                {
                    result: resultText,
                    error,
                    sessionId: engine.sessionId,
                    model: engine.modelSpec,
                    applied: written,
                    staged,
                    queuedCommands,
                    usage: { inputTokens: usage.input, outputTokens: usage.output, modelCalls: usage.calls },
                    costUsd: engine.usage.cost(engine.config.pricing),
                },
                null,
                2,
            ) + "\n",
        );
        return exitCode;
    }

    if (error) err(chalk.red(`❌ ${error}`));
    if (written.length) err(chalk.green(`✓ Wrote ${written.join(", ")}  (undo: rushclaw-build undo)`));
    if (staged.length) {
        err(chalk.yellow(`\n${staged.length} change(s) were proposed but NOT applied (re-run with --yes to apply):`));
        for (const s of staged) err(s.diff || `${s.type} ${s.path}`);
    }
    if (queuedCommands.length)
        err(chalk.yellow(`Commands not run (not on the allowlist): ${queuedCommands.join(" ; ")}`));
    err(chalk.dim(`↳ ${engine.usage.formatTurn()} · session ${engine.sessionId}`));
    return exitCode;
}
