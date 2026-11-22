import type { ToolSet } from "ai";
import type { HookConfig, HooksConfig } from "./config";
import { runShell } from "./shell";

export type HookEvent = "PreToolUse" | "PostToolUse" | "PostApply";

export interface HookPayload {
    tool_name?: string;
    tool_input?: unknown;
    tool_output?: unknown;
    /** PostApply: files written to disk. */
    files?: string[];
}

export interface HookRun {
    command: string;
    code: number | null;
    output: string;
}

const DEFAULT_TIMEOUT = 30_000;

export function hookMatches(h: HookConfig, toolName: string | undefined): boolean {
    if (!h.matcher || !toolName) return true;
    try {
        return new RegExp(`^(?:${h.matcher})$`).test(toolName);
    } catch {
        return h.matcher === toolName;
    }
}

function quote(p: string): string {
    return /[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p;
}

/**
 * Expand $RUSHCLAW_* / ${RUSHCLAW_*} in the command ourselves, so the same hook
 * works in cmd.exe (Windows) and sh.
 */
export function expandHookCommand(command: string, vars: Record<string, string>): string {
    return command.replace(/\$\{?(RUSHCLAW_[A-Z_]+)\}?/g, (m, name: string) => (name in vars ? vars[name]! : m));
}

function hookVars(event: HookEvent, payload: HookPayload): Record<string, string> {
    const input = payload.tool_input as Record<string, unknown> | undefined;
    const filePath = typeof input?.path === "string" ? input.path : "";
    return {
        RUSHCLAW_EVENT: event,
        RUSHCLAW_TOOL_NAME: payload.tool_name ?? "",
        RUSHCLAW_TOOL_INPUT: input ? JSON.stringify(input).slice(0, 8000) : "",
        RUSHCLAW_FILE_PATH: filePath ? quote(filePath) : "",
        RUSHCLAW_CHANGED_FILES: (payload.files ?? []).map(quote).join(" "),
    };
}

/**
 * Run all hooks for an event. Each hook gets the event as JSON on stdin and as
 * RUSHCLAW_* environment variables. Exit code 2 from a PreToolUse hook blocks
 * the tool call.
 */
export async function runHooks(
    event: HookEvent,
    hooks: HookConfig[] | undefined,
    payload: HookPayload,
    root: string,
): Promise<HookRun[]> {
    const runs: HookRun[] = [];
    for (const h of hooks ?? []) {
        if (!hookMatches(h, payload.tool_name)) continue;
        const vars = hookVars(event, payload);
        const command = expandHookCommand(h.command, vars);
        const r = await runShell(command, {
            cwd: root,
            timeoutMs: h.timeoutMs ?? DEFAULT_TIMEOUT,
            env: vars,
            input: JSON.stringify({ event, ...payload }),
        });
        const output = [r.stdout.trim(), r.stderr.trim(), r.timedOut ? "(hook timed out)" : ""].filter(Boolean).join("\n");
        runs.push({ command: h.command, code: r.timedOut ? null : r.code, output: output.slice(0, 4000) });
    }
    return runs;
}

/** Wrap every tool so PreToolUse / PostToolUse hooks run around it. */
export function wrapToolsWithHooks(
    tools: ToolSet,
    hooks: HooksConfig,
    root: string,
    report?: (message: string) => void,
): ToolSet {
    if (!hooks.preToolUse?.length && !hooks.postToolUse?.length) return tools;
    const out: ToolSet = {};
    for (const [name, t] of Object.entries(tools)) {
        const original = (t as any).execute as ((input: unknown, options: unknown) => Promise<unknown>) | undefined;
        if (!original) {
            out[name] = t;
            continue;
        }
        out[name] = {
            ...(t as any),
            execute: async (input: unknown, options: unknown) => {
                const pre = await runHooks("PreToolUse", hooks.preToolUse, { tool_name: name, tool_input: input }, root);
                for (const r of pre) {
                    if (r.code === 2) {
                        report?.(`PreToolUse hook blocked ${name}: ${r.output || r.command}`);
                        return `Blocked by a PreToolUse hook (${r.command}): ${r.output || "no reason given"}. Do not retry the same call; adjust your approach.`;
                    }
                    if (r.code !== 0) report?.(`PreToolUse hook "${r.command}" exited ${r.code}: ${r.output}`);
                }

                const result = await original(input, options);

                const post = await runHooks(
                    "PostToolUse",
                    hooks.postToolUse,
                    { tool_name: name, tool_input: input, tool_output: typeof result === "string" ? result.slice(0, 8000) : result },
                    root,
                );
                const feedback = post.filter((r) => r.code !== 0);
                if (!feedback.length) return result;
                for (const r of feedback) report?.(`PostToolUse hook "${r.command}" exited ${r.code}`);
                if (typeof result !== "string") return result;
                // Non-zero post hooks (e.g. a linter) are fed back to the model.
                return (
                    result +
                    feedback.map((r) => `\n\n[PostToolUse hook "${r.command}" exited ${r.code}]\n${r.output}`).join("")
                );
            },
        } as any;
    }
    return out;
}
