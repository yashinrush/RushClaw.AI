import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateText, type LanguageModel } from "ai";
import type { UsageLike } from "./usage";

export interface GitResult {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
}

export function git(args: string[], cwd: string, input?: string): GitResult {
    const r = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        input,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
    });
    return {
        ok: r.status === 0,
        code: r.status,
        stdout: r.stdout ?? "",
        stderr: (r.stderr ?? "") + (r.error ? String(r.error.message) : ""),
    };
}

export function isGitRepo(cwd: string): boolean {
    return git(["rev-parse", "--is-inside-work-tree"], cwd).stdout.trim() === "true";
}

export function currentBranch(cwd: string): string {
    return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).stdout.trim();
}

export function hasCommits(cwd: string): boolean {
    return git(["rev-parse", "--verify", "HEAD"], cwd).ok;
}

/** origin's default branch (origin/HEAD), else main / master. */
export function defaultBranch(cwd: string): string {
    const sym = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
    if (sym.ok && sym.stdout.trim()) return sym.stdout.trim().replace(/^origin\//, "");
    for (const b of ["main", "master"]) {
        if (git(["rev-parse", "--verify", "--quiet", b], cwd).ok) return b;
        if (git(["rev-parse", "--verify", "--quiet", `origin/${b}`], cwd).ok) return b;
    }
    return "main";
}

export interface StatusEntry {
    path: string;
    /** Two-letter porcelain code, e.g. " M", "A ", "??". */
    code: string;
    untracked: boolean;
}

/** `git status --porcelain -z`, renames reported under their new path. */
export function statusEntries(cwd: string): StatusEntry[] {
    const r = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd);
    if (!r.ok) return [];
    const parts = r.stdout.split("\0").filter(Boolean);
    const out: StatusEntry[] = [];
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i]!;
        const code = entry.slice(0, 2);
        const p = entry.slice(3);
        if (code[0] === "R" || code[0] === "C") i++; // skip the "from" path
        out.push({ path: p, code, untracked: code === "??" });
    }
    return out;
}

export function describeStatus(code: string): string {
    if (code === "??") return "new";
    if (code.includes("D")) return "deleted";
    if (code.includes("R")) return "renamed";
    if (code.includes("A")) return "added";
    return "modified";
}

const MAX_DIFF = 60_000;

function clipDiff(d: string): string {
    return d.length > MAX_DIFF ? d.slice(0, MAX_DIFF) + `\n…[diff truncated, ${d.length - MAX_DIFF} more chars]` : d;
}

/** Diff of the given files against HEAD; untracked files are shown as new files. */
export function diffForFiles(cwd: string, entries: StatusEntry[]): string {
    const tracked = entries.filter((e) => !e.untracked).map((e) => e.path);
    const parts: string[] = [];
    if (tracked.length) {
        const args = hasCommits(cwd) ? ["diff", "HEAD", "--", ...tracked] : ["diff", "--cached", "--", ...tracked];
        parts.push(git(args, cwd).stdout);
    }
    for (const e of entries.filter((x) => x.untracked)) {
        try {
            const abs = path.join(cwd, e.path);
            const st = fs.statSync(abs);
            if (st.size > 200_000) {
                parts.push(`new file ${e.path} (${st.size} bytes, not shown)`);
                continue;
            }
            const lines = fs.readFileSync(abs, "utf8").split("\n").slice(0, 300);
            parts.push(`new file ${e.path}\n${lines.map((l) => "+" + l).join("\n")}`);
        } catch { }
    }
    return clipDiff(parts.join("\n"));
}

/** Working tree vs HEAD (staged + unstaged). */
export function workingDiff(cwd: string): string {
    if (!hasCommits(cwd)) return git(["diff", "--cached"], cwd).stdout + git(["diff"], cwd).stdout;
    return git(["diff", "HEAD"], cwd).stdout;
}

export function ghAvailable(): boolean {
    const r = spawnSync("gh", ["--version"], { encoding: "utf8", windowsHide: true });
    return r.status === 0;
}

// ───────────────────────── AI helpers ─────────────────────────

interface AiText {
    text: string;
    usage: UsageLike | undefined;
    modelId?: string;
}

async function ask(model: LanguageModel, system: string, prompt: string): Promise<AiText> {
    const r = await generateText({ model, system, prompt });
    return { text: r.text.trim(), usage: r.usage, modelId: r.response?.modelId };
}

export async function generateCommitMessage(model: LanguageModel, diff: string, recentLog: string): Promise<AiText> {
    const r = await ask(
        model,
        "You write git commit messages. Output ONLY the commit message — no quotes, no code fences, no commentary.",
        [
            "Write a commit message for this diff.",
            "- Subject line: imperative mood, ≤ 72 chars. Follow the style of the recent commits below (e.g. Conventional Commits prefixes) if they have one.",
            "- Then a blank line and a short body (bullets are fine) explaining what changed and why, only if the change isn't trivial.",
            "",
            `Recent commits:\n${recentLog || "(none)"}`,
            "",
            `Diff:\n${diff}`,
        ].join("\n"),
    );
    return { ...r, text: r.text.replace(/^```\w*\n?|```$/g, "").trim() };
}

export async function reviewDiff(model: LanguageModel, diff: string, context: string): Promise<AiText> {
    return ask(
        model,
        "You are a senior software engineer doing a careful code review. Be specific and actionable; cite file and line. Don't pad the review with praise.",
        [
            "Review this diff. Report, most important first:",
            "1. Bugs and correctness problems (logic errors, edge cases, crashes, wrong API use)",
            "2. Security issues",
            "3. Missing tests / error handling",
            "4. Readability or simplification suggestions (brief)",
            "If it looks good, say so in one line. Use Markdown with a short heading per finding.",
            context ? `\nProject context:\n${context.slice(0, 6000)}` : "",
            `\nDiff:\n${diff}`,
        ].join("\n"),
    );
}

export async function generatePrDescription(
    model: LanguageModel,
    commits: string,
    diffStat: string,
    diff: string,
): Promise<AiText & { title: string; body: string }> {
    const r = await ask(
        model,
        "You write pull request titles and descriptions. Follow the exact output format requested.",
        [
            "Write a pull request for these changes. Output exactly:",
            "TITLE: <one line, ≤ 72 chars>",
            "BODY:",
            "## Summary",
            "<2-4 bullets: what and why>",
            "## Changes",
            "<bullets grouped by area>",
            "## Testing",
            "<how it was / should be verified>",
            "",
            `Commits:\n${commits}`,
            `\nDiff stat:\n${diffStat}`,
            `\nDiff:\n${diff}`,
        ].join("\n"),
    );
    const m = r.text.match(/TITLE:\s*(.+)\n+BODY:\s*\n?([\s\S]*)/i);
    const title = (m?.[1] ?? r.text.split("\n")[0] ?? "Update").trim().slice(0, 120);
    const body = (m?.[2] ?? r.text).trim();
    return { ...r, title, body };
}
