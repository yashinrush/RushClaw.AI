import fs from "node:fs";
import path from "node:path";
import { rushclawHome } from "./config";

/** Project instructions file, loaded into every prompt (like CLAUDE.md). */
export const MEMORY_FILE = "RUSHCLAW.md";
/** Read these instead when a project has no RUSHCLAW.md yet. */
const COMPAT_FILES = ["CLAUDE.md", "AGENTS.md"];
const MAX_CHARS_PER_FILE = 20_000;

export interface MemorySource {
    path: string;
    scope: "user" | "project";
    chars: number;
}

export interface LoadedMemory {
    text: string;
    sources: MemorySource[];
}

function readCapped(file: string): string | null {
    try {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
        const t = fs.readFileSync(file, "utf8").trim();
        if (!t) return null;
        return t.length > MAX_CHARS_PER_FILE
            ? t.slice(0, MAX_CHARS_PER_FILE) + "\n…[truncated]"
            : t;
    } catch {
        return null;
    }
}

/**
 * User memory (~/.rushclaw/RUSHCLAW.md) applies to every project; project memory
 * (<root>/RUSHCLAW.md, or CLAUDE.md / AGENTS.md as a fallback) holds the repo's conventions.
 */
export function loadMemory(root: string): LoadedMemory {
    const sources: MemorySource[] = [];
    const blocks: string[] = [];

    const add = (file: string, scope: "user" | "project") => {
        const t = readCapped(file);
        if (t === null) return false;
        sources.push({ path: file, scope, chars: t.length });
        blocks.push(`<!-- ${scope} memory: ${file} -->\n${t}`);
        return true;
    };

    add(path.join(rushclawHome(), MEMORY_FILE), "user");
    const hasProject =
        add(path.join(root, MEMORY_FILE), "project") ||
        add(path.join(root, ".rushclaw", MEMORY_FILE), "project");
    if (!hasProject) {
        for (const f of COMPAT_FILES) if (add(path.join(root, f), "project")) break;
    }

    return { text: blocks.join("\n\n"), sources };
}

export function projectMemoryPath(root: string): string {
    return path.join(root, MEMORY_FILE);
}

/** Prompt used by /init to have the agent write RUSHCLAW.md. */
export const INIT_PROMPT = `Analyze this codebase and create a ${MEMORY_FILE} file in the project root. It is loaded into every future RushClaw session, so it must help an AI coding agent work in this repo.

Investigate first (list_files, read package/config files, the README, a few representative source files, grep for test setup). Then write ${MEMORY_FILE} with:
1. A 2-3 sentence overview of what the project is.
2. Commands: install, run, build, test (all tests and a single test), lint, type-check — only commands that actually exist here.
3. Architecture: the main folders/modules and how they fit together (the big picture that needs several files to understand).
4. Conventions: language/style rules, naming, error handling, patterns to follow, things to avoid — only what you actually observed.
5. Gotchas: anything surprising or easy to get wrong.

Keep it concise (under ~120 lines), specific to this repo, and do not invent anything. If ${MEMORY_FILE} already exists, improve it with edit_file instead of replacing it.`;
