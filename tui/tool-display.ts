import chalk from "chalk";

function str(v: unknown): string {
    return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
}

function clip(s: string, n: number): string {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Human label for a tool call, e.g. `Edit modes/cli.ts` or `Run bun test`. */
export function toolLabel(name: string, input: unknown): string {
    const i = (input ?? {}) as Record<string, unknown>;
    switch (name) {
        case "read_file":
            return `Read ${i.path}${i.offset ? ` (from line ${i.offset})` : ""}`;
        case "list_files":
            return `List ${i.path}${i.recursive ? " (recursive)" : ""}`;
        case "search_files":
            return `Find ${i.pattern} in ${i.root}`;
        case "grep":
            return `Grep /${clip(str(i.pattern), 50)}/${i.path ? ` in ${i.path}` : ""}${i.glob ? ` (${i.glob})` : ""}`;
        case "analyze_codebase":
            return `Analyze ${i.path ?? "."}`;
        case "edit_file":
            return `Edit ${i.path}`;
        case "create_file":
            return `Create ${i.path}`;
        case "modify_file":
            return `Rewrite ${i.path}`;
        case "delete_file":
            return `Delete ${i.path}`;
        case "create_folder":
            return `Mkdir ${i.path}`;
        case "run_command":
            return `Run ${clip(str(i.command), 90)}`;
        case "todo_write":
            return "Update todo list";
        case "task":
            return `Sub-agent: ${clip(str(i.description), 70)}`;
        case "web_search":
            return `Web search "${clip(str(i.query), 60)}"`;
        case "web_crawl":
        case "fetch_url":
            return `Fetch ${i.url}`;
        case "list_skills":
            return "List skills";
        case "read_skill":
            return `Read skill ${i.path}`;
        default: {
            const label = name.startsWith("mcp__") ? name.split("__").slice(1).join(" › ") : name;
            return `${label}(${clip(str(input), 70)})`;
        }
    }
}

/** One-line summary of a tool result. */
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

export function printToolCall(name: string, input: unknown): void {
    console.log(`${chalk.magenta("⏺")} ${chalk.bold(toolLabel(name, input))}`);
}

export function printToolResult(name: string, output: unknown): void {
    if (name === "todo_write") return; // the checklist itself is printed
    const failed = name === "run_command" && /exit code: (?!0\b)/.test(str(output));
    const line = resultSummary(name, output);
    console.log(`  ${chalk.dim("⎿")}  ${failed ? chalk.yellow(line) : chalk.dim(line)}`);
}

export function printToolError(name: string, error: unknown): void {
    const msg = error instanceof Error ? error.message : str(error);
    console.log(`  ${chalk.dim("⎿")}  ${chalk.red(clip(msg, 160))}`);
}
