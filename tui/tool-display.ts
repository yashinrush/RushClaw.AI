import { diffLines } from "diff";
import { fmtDuration, sym, t, termWidth, truncateVisible } from "./theme";

function str(v: unknown): string {
    return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
}

function clip(s: string, n: number): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

export type ToolKind = "read" | "edit" | "run" | "agent" | "web" | "mcp" | "todo" | "other";

export function toolKind(name: string): ToolKind {
    if (name.startsWith("mcp__")) return "mcp";
    switch (name) {
        case "read_file":
        case "list_files":
        case "search_files":
        case "grep":
        case "analyze_codebase":
        case "list_skills":
        case "read_skill":
            return "read";
        case "edit_file":
        case "create_file":
        case "modify_file":
        case "delete_file":
        case "create_folder":
            return "edit";
        case "run_command":
            return "run";
        case "task":
            return "agent";
        case "web_search":
        case "web_crawl":
        case "fetch_url":
            return "web";
        case "todo_write":
            return "todo";
        default:
            return "other";
    }
}

const KIND_COLOR: Record<ToolKind, (s: string) => string> = {
    read: t.read,
    edit: t.edit,
    run: t.run,
    agent: t.agent,
    web: t.web,
    mcp: t.mcp,
    todo: t.ok,
    other: t.muted,
};

/** Verb + detail for a tool call, e.g. { verb: "Edit", detail: "src/app.ts" }. */
export function toolParts(name: string, input: unknown): { verb: string; detail: string; kind: ToolKind } {
    const i = (input ?? {}) as Record<string, unknown>;
    const kind = toolKind(name);
    const p = (verb: string, detail = "") => ({ verb, detail, kind });
    switch (name) {
        case "read_file":
            return p("Read", `${i.path}${i.offset ? ` (from line ${i.offset})` : ""}`);
        case "list_files":
            return p("List", `${i.path}${i.recursive ? " (recursive)" : ""}`);
        case "search_files":
            return p("Find", `${i.pattern} in ${i.root}`);
        case "grep":
            return p("Grep", `/${clip(str(i.pattern), 50)}/${i.path ? ` in ${i.path}` : ""}${i.glob ? ` (${i.glob})` : ""}`);
        case "analyze_codebase":
            return p("Analyze", String(i.path ?? "."));
        case "edit_file":
            return p("Edit", String(i.path));
        case "create_file":
            return p("Create", String(i.path));
        case "modify_file":
            return p("Rewrite", String(i.path));
        case "delete_file":
            return p("Delete", String(i.path));
        case "create_folder":
            return p("Mkdir", String(i.path));
        case "run_command":
            return p("Run", clip(str(i.command), 90));
        case "todo_write":
            return p("Update todo list");
        case "task":
            return p("Sub-agent:", clip(str(i.description), 70));
        case "web_search":
            return p("Web search", `"${clip(str(i.query), 60)}"`);
        case "web_crawl":
        case "fetch_url":
            return p("Fetch", String(i.url));
        case "list_skills":
            return p("List skills");
        case "read_skill":
            return p("Read skill", String(i.path));
        default: {
            const label = name.startsWith("mcp__") ? name.split("__").slice(1).join(" › ") : name;
            return p(label, `(${clip(str(input), 70)})`);
        }
    }
}

/** Plain label, e.g. `Edit modes/cli.ts` (used by Telegram, headless, sub-agent lines). */
export function toolLabel(name: string, input: unknown): string {
    const { verb, detail } = toolParts(name, input);
    return detail ? `${verb} ${detail}` : verb;
}

/** One-line plain summary of a tool result. */
export function resultSummary(name: string, output: unknown): string {
    const s = str(output);
    switch (name) {
        case "read_file": {
            const lines = s.split("\n").length;
            return `${lines} line${lines === 1 ? "" : "s"}${s.startsWith("[staged version") ? " (staged)" : ""}`;
        }
        case "grep": {
            const last = s.trim().split("\n").pop() ?? "";
            return /match\(es\)/.test(last) ? clip(last, 90) : "no matches";
        }
        case "list_files":
        case "search_files": {
            if (s.startsWith("(")) return s;
            return `${s.split("\n").length} entr${s.split("\n").length === 1 ? "y" : "ies"}`;
        }
        case "run_command": {
            const code = s.match(/exit code: (\S+)/)?.[1];
            const lines = s.trim().split("\n");
            const tail = lines.length > 2 ? lines[lines.length - 1]! : "";
            if (s.includes("QUEUED")) return "queued for approval";
            if (s.startsWith("The user denied")) return "denied";
            return `exit ${code ?? "?"}${tail ? ` · ${clip(tail, 70)}` : ""}`;
        }
        case "task":
            return `${s.split("\n").length} line report`;
        default:
            return clip(s.split("\n")[0] ?? "", 100);
    }
}

// ───────────────────────── terminal formatting ─────────────────────────

const LEAD = `  ${t.dim(sym.branch)}  `;
const CONT = "     ";

function fit(line: string): string {
    return truncateVisible(line, termWidth() - 2);
}

export function formatToolCall(name: string, input: unknown): string {
    const { verb, detail, kind } = toolParts(name, input);
    return fit(`${KIND_COLOR[kind](sym.dot)} ${t.bold(verb)}${detail ? " " + t.muted(detail) : ""}`);
}

/** Changed lines between two snippets, at most `max` lines shown. */
export function miniDiff(before: string, after: string, max = 8): { lines: string[]; added: number; removed: number } {
    const out: string[] = [];
    let added = 0;
    let removed = 0;
    let hidden = 0;
    for (const part of diffLines(before, after)) {
        if (!part.added && !part.removed) continue;
        const lines = part.value.replace(/\n$/, "").split("\n");
        for (const l of lines) {
            if (part.added) added++;
            else removed++;
            if (out.length >= max) {
                hidden++;
                continue;
            }
            out.push(part.added ? t.ok(`+ ${l}`) : t.err(`- ${l}`));
        }
    }
    if (hidden) out.push(t.dim(`… ${hidden} more changed line(s)`));
    return { lines: out, added, removed };
}

/** Lines printed under a tool call once it finishes. */
export function formatToolResult(name: string, output: unknown, input?: unknown, ms?: number): string[] {
    if (name === "todo_write") return []; // the checklist itself is printed
    const s = str(output);
    const i = (input ?? {}) as Record<string, unknown>;
    const took = ms !== undefined && ms >= 800 ? t.dim(` · ${fmtDuration(ms)}`) : "";

    if (name === "edit_file" && typeof i.old_string === "string" && typeof i.new_string === "string" && s.startsWith("Edited")) {
        const d = miniDiff(i.old_string, i.new_string, 6);
        return [
            fit(`${LEAD}${t.muted("Updated")} ${t.ok(`+${d.added}`)} ${t.err(`-${d.removed}`)}${took}`),
            ...d.lines.map((l) => fit(CONT + l)),
        ];
    }
    if (name === "create_file" && typeof i.content === "string" && s.startsWith("Staged new file")) {
        const n = i.content.split("\n").length;
        return [fit(`${LEAD}${t.muted("Created")} ${t.ok(`+${n} line${n === 1 ? "" : "s"}`)}${took}`)];
    }
    if (name === "modify_file" && typeof i.content === "string") {
        return [fit(`${LEAD}${t.muted("Rewrote")} ${i.content.split("\n").length} lines${took}`)];
    }
    if (name === "delete_file") return [fit(`${LEAD}${t.err("Deleted")}${took}`)];

    if (name === "run_command") {
        if (s.includes("QUEUED")) return [fit(`${LEAD}${t.warn("queued — runs only if you approve it after this turn")}`)];
        if (s.startsWith("The user denied")) return [fit(`${LEAD}${t.err(`${sym.cross} denied`)}`)];
        const code = s.match(/exit code: (\S+)/)?.[1];
        const ok = code === "0";
        const badge = ok ? t.ok(`${sym.check} exit 0`) : t.err(`${sym.cross} exit ${code ?? "?"}`);
        const body = s
            .split("\n")
            .slice(2) // "$ cmd" and "exit code: N"
            .filter((l) => l.trim() && !l.startsWith("Note:") && l.trim() !== "(no output)");
        const tail = body.slice(-3).map((l) => fit(CONT + t.dim(l)));
        return [fit(`${LEAD}${badge}${took}`), ...tail];
    }

    const summary = resultSummary(name, output);
    return [fit(`${LEAD}${t.muted(summary)}${took}`)];
}

export function formatToolError(_name: string, error: unknown): string {
    const msg = error instanceof Error ? error.message : str(error);
    return fit(`${LEAD}${t.err(`${sym.cross} ${clip(msg, 200)}`)}`);
}

export function printToolCall(name: string, input: unknown): void {
    console.log(formatToolCall(name, input));
}

export function printToolResult(name: string, output: unknown, input?: unknown, ms?: number): void {
    for (const l of formatToolResult(name, output, input, ms)) console.log(l);
}

export function printToolError(name: string, error: unknown): void {
    console.log(formatToolError(name, error));
}
