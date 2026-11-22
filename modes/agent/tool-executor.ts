import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import type { AgentConfig, ActionLog } from "./types";
import { ActionTracker } from "./action-tracker";

const TEXT_EXT = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".md",
    ".mdx",
    ".css",
    ".scss",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".txt",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".c",
    ".h",
    ".cpp",
    ".hpp",
    ".cs",
    ".rb",
    ".php",
    ".sh",
    ".sql",
    ".vue",
    ".svelte",
    ".xml",
    ".svg",
    ".ini",
    ".cfg",
]);

/** Max characters returned by a single read_file call before truncation. */
const MAX_READ_CHARS = 120_000;
/** Max lines returned by a single grep call. */
const MAX_GREP_LINES = 250;

export function isProbablyTextFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return TEXT_EXT.has(ext) || ext === "";
}

export interface GrepOptions {
    /** Directory or file to search, relative to the workspace root. */
    path?: string;
    /** Only search files whose path matches this glob (e.g. "*.ts", "src/**"). */
    glob?: string;
    ignoreCase?: boolean;
    /** Lines of context to show before and after each match. */
    context?: number;
    /** Return only the list of matching files. */
    filesOnly?: boolean;
}

export function globToRegExp(glob: string): RegExp {
    const escaped = glob
        .replace(/\\/g, "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "§§SLASH")
        .replace(/\*\*/g, "§§")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/§§SLASH/g, "(?:.*/)?")
        .replace(/§§/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
}

export class ToolExecutor {
    private overlay = new Map<string, string>();
    private deleted = new Set<string>();

    constructor(
        private readonly tracker: ActionTracker,
        private readonly config: AgentConfig,
    ) { }

    get root(): string {
        return path.resolve(this.config.codebasePath);
    }

    private resolveSafe(rel: string): string {
        const abs = path.resolve(this.config.codebasePath, rel);
        const root = path.resolve(this.config.codebasePath);
        const relCheck = path.relative(root, abs);
        if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
            throw new Error(`Path escapes workspace: ${rel}`);
        }
        return abs;
    }

    /**
     * Canonical key for a workspace path: relative to the root, forward slashes.
     * Works for both relative and absolute inputs so staged state never splits
     * across two spellings of the same file.
     */
    keyOf(rel: string): string {
        const abs = this.resolveSafe(rel);
        return path.relative(this.root, abs).split(path.sep).join("/");
    }

    private excluded(relPath: string): boolean {
        const norm = relPath.split(path.sep).join("/").replace(/^\.\//, "");
        const segments = norm.split("/");
        const base = segments[segments.length - 1] ?? "";

        for (const pat of this.config.excludePatterns) {
            if (pat.startsWith("*.") && base.endsWith(pat.slice(1))) return true;
            if (pat.endsWith("*") && !pat.slice(0, -1).includes("*")) {
                if (base.startsWith(pat.slice(0, -1))) return true;
                continue;
            }
            if (pat.includes("*")) continue;
            if (segments.includes(pat) || norm === pat || norm.startsWith(`${pat}/`))
                return true;
        }
        return false;
    }

    private assertNotExcluded(rel: string, op: string): void {
        if (this.excluded(this.keyOf(rel))) {
            throw new Error(`${op}: path is excluded by policy: ${rel}`);
        }
    }

    /** Current content of a file as the agent should see it: staged version first, then disk. */
    getEffectiveText(rel: string): string | undefined {
        const key = this.keyOf(rel);
        if (this.deleted.has(key)) return undefined;
        if (this.overlay.has(key)) return this.overlay.get(key);
        const abs = this.resolveSafe(rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return undefined;
        return fs.readFileSync(abs, "utf8");
    }

    /** Paths with staged (not yet applied) content. */
    stagedPaths(): string[] {
        return [...this.overlay.keys(), ...this.deleted].sort();
    }

    hasStagedChanges(): boolean {
        return this.overlay.size > 0 || this.deleted.size > 0;
    }

    readFile(rel: string, offset?: number, limit?: number): string {
        this.assertNotExcluded(rel, "read_file");
        const key = this.keyOf(rel);
        let text: string;
        let staged = false;
        if (this.deleted.has(key)) {
            throw new Error(`File not found (staged for deletion): ${rel}`);
        } else if (this.overlay.has(key)) {
            text = this.overlay.get(key)!;
            staged = true;
        } else {
            const abs = this.resolveSafe(rel);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                throw new Error(`File not found: ${rel}`);
            }
            const st = fs.statSync(abs);
            if (st.size > this.config.maxFileSizeToRead) {
                throw new Error(
                    `File too large (${st.size} bytes): ${rel}. Use grep, or read_file with offset/limit.`,
                );
            }
            text = fs.readFileSync(abs, "utf8");
        }

        let out = text;
        if (offset !== undefined || limit !== undefined) {
            const lines = text.split("\n");
            const start = Math.max(0, (offset ?? 1) - 1);
            const end = limit !== undefined ? start + limit : lines.length;
            out = lines.slice(start, end).join("\n");
            if (end < lines.length)
                out += `\n…[showing lines ${start + 1}-${end} of ${lines.length}]`;
        }
        if (out.length > MAX_READ_CHARS) {
            out =
                out.slice(0, MAX_READ_CHARS) +
                `\n…[truncated at ${MAX_READ_CHARS} chars; use offset/limit to read further]`;
        }

        this.tracker.log({
            type: "code_analysis",
            path: key,
            details: { after: out, toolName: "read_file" },
            status: "executed",
        });
        return staged ? `[staged version — not yet written to disk]\n${out}` : out;
    }

    createFile(rel: string, content: string): string {
        if (!this.config.tools.allowFileCreation)
            throw new Error("File creation disabled");
        this.assertNotExcluded(rel, "create_file");
        const key = this.keyOf(rel);
        if (this.getEffectiveText(rel) !== undefined) {
            throw new Error(
                `create_file: already exists: ${rel}. Use edit_file to change it.`,
            );
        }
        this.deleted.delete(key);
        this.overlay.set(key, content);
        this.tracker.log({
            type: "file_create",
            path: key,
            details: { after: content },
            status: "pending",
        });
        return `Staged new file: ${key}`;
    }

    modifyFile(rel: string, content: string): string {
        if (!this.config.tools.allowFileModification)
            throw new Error("File modification disabled");
        this.assertNotExcluded(rel, "modify_file");
        const before = this.getEffectiveText(rel);
        if (before === undefined)
            throw new Error(`modify_file: file not found: ${rel}`);
        const key = this.keyOf(rel);
        this.overlay.set(key, content);
        this.tracker.log({
            type: "file_modify",
            path: key,
            details: { before, after: content },
            status: "pending",
        });
        return `Staged update: ${key}`;
    }

    /**
     * Exact string replacement. `oldString` must match exactly once unless
     * `replaceAll` is set — this keeps edits small and prevents the model from
     * accidentally rewriting code it never meant to touch.
     */
    editFile(
        rel: string,
        oldString: string,
        newString: string,
        replaceAll = false,
    ): string {
        if (!this.config.tools.allowFileModification)
            throw new Error("File modification disabled");
        this.assertNotExcluded(rel, "edit_file");
        const before = this.getEffectiveText(rel);
        if (before === undefined)
            throw new Error(`edit_file: file not found: ${rel}. Use create_file for new files.`);
        if (oldString === "")
            throw new Error("edit_file: old_string must not be empty. Use create_file for new files.");
        if (oldString === newString)
            throw new Error("edit_file: old_string and new_string are identical.");

        let oldS = oldString;
        let newS = newString;
        let count = countOccurrences(before, oldS);

        // Windows files: the model usually sends LF; retry with CRLF.
        if (count === 0 && before.includes("\r\n") && !oldS.includes("\r\n")) {
            const crlfOld = oldS.replace(/\n/g, "\r\n");
            const crlfCount = countOccurrences(before, crlfOld);
            if (crlfCount > 0) {
                oldS = crlfOld;
                newS = newS.replace(/\r?\n/g, "\r\n");
                count = crlfCount;
            }
        }

        if (count === 0) {
            throw new Error(
                `edit_file: old_string not found in ${rel}. Re-read the file with read_file and copy the text exactly (including whitespace and indentation).`,
            );
        }
        if (count > 1 && !replaceAll) {
            throw new Error(
                `edit_file: old_string matches ${count} places in ${rel}. Include more surrounding lines to make it unique, or set replace_all: true.`,
            );
        }

        const after = replaceAll
            ? before.split(oldS).join(newS)
            : before.replace(oldS, () => newS);
        const firstIdx = before.indexOf(oldS);
        const line = before.slice(0, firstIdx).split("\n").length;

        const key = this.keyOf(rel);
        this.overlay.set(key, after);
        this.tracker.log({
            type: "file_modify",
            path: key,
            details: { before, after, toolName: "edit_file" },
            status: "pending",
        });
        return `Edited ${key}: replaced ${replaceAll ? count : 1} occurrence(s) starting at line ${line}.`;
    }

    deleteFile(rel: string): string {
        if (!this.config.tools.allowFileModification)
            throw new Error("File deletion disabled");
        this.assertNotExcluded(rel, "delete_file");
        const before = this.getEffectiveText(rel);
        if (before === undefined)
            throw new Error(`delete_file: file not found: ${rel}`);
        const key = this.keyOf(rel);
        this.overlay.delete(key);
        this.deleted.add(key);
        this.tracker.log({
            type: "file_delete",
            path: key,
            details: { before },
            status: "pending",
        });
        return `Staged delete: ${key}`;
    }

    createFolder(rel: string): string {
        if (!this.config.tools.allowFolderCreation)
            throw new Error("Folder creation disabled");
        this.assertNotExcluded(rel, "create_folder");
        const key = this.keyOf(rel);
        this.tracker.log({
            type: "folder_create",
            path: key,
            details: { after: key },
            status: "pending",
        });
        return `Staged folder: ${key}`;
    }

    /** All workspace files (relative keys) the agent can currently see: disk + staged − deleted. */
    private visibleFiles(rootRel: string): string[] {
        const rootAbs = this.resolveSafe(rootRel);
        const rootKey = this.keyOf(rootRel);
        const out = new Set<string>();

        const walk = (dir: string) => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                const key = path.relative(this.root, full).split(path.sep).join("/");
                if (this.excluded(key)) continue;
                if (ent.isDirectory()) walk(full);
                else if (ent.isFile()) out.add(key);
            }
        };

        if (fs.existsSync(rootAbs)) {
            if (fs.statSync(rootAbs).isDirectory()) walk(rootAbs);
            else out.add(rootKey);
        }
        for (const key of this.overlay.keys()) {
            if (rootKey === "" || key === rootKey || key.startsWith(rootKey + "/"))
                out.add(key);
        }
        for (const key of this.deleted) out.delete(key);
        return [...out].sort();
    }

    listFiles(rel: string, recursive: boolean): string {
        this.assertNotExcluded(rel, "list_files");
        const abs = this.resolveSafe(rel);
        const dirKey = this.keyOf(rel);
        const stagedUnder = [...this.overlay.keys()].filter(
            (k) => dirKey === "" || k.startsWith(dirKey + "/"),
        );
        if (!fs.existsSync(abs) && stagedUnder.length === 0)
            throw new Error(`list_files: not found: ${rel}`);

        const lines = new Set<string>();
        const walk = (dir: string, prefix: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const ent of entries) {
                const full = path.join(dir, ent.name);
                const relP = path.relative(this.root, full).split(path.sep).join("/");
                if (this.excluded(relP)) continue;
                if (ent.isDirectory()) {
                    lines.add(`${prefix}${ent.name}/`);
                    if (recursive) walk(full, `${prefix}${ent.name}/`);
                } else if (!this.deleted.has(relP)) {
                    lines.add(`${prefix}${ent.name}`);
                }
            }
        };

        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, "");
        else if (fs.existsSync(abs)) lines.add(dirKey);

        // Staged new files are part of the agent's view of the workspace.
        for (const key of stagedUnder) {
            const rest = dirKey === "" ? key : key.slice(dirKey.length + 1);
            const parts = rest.split("/");
            if (!recursive) {
                if (parts.length > 1) lines.add(`${parts[0]}/`);
                else if (!lines.has(rest)) lines.add(`${rest} (staged)`);
                continue;
            }
            for (let i = 1; i < parts.length; i++)
                lines.add(parts.slice(0, i).join("/") + "/");
            if (!lines.has(rest)) lines.add(`${rest} (staged)`);
        }

        const out = [...lines].sort().join("\n");
        this.tracker.log({
            type: "code_analysis",
            path: dirKey,
            details: { after: out, toolName: "list_files" },
            status: "executed",
        });
        return out || "(empty)";
    }

    searchFiles(
        rootRel: string,
        globPattern: string,
        contentQuery?: string,
    ): string {
        this.assertNotExcluded(rootRel, "search_files");
        const rootAbs = this.resolveSafe(rootRel);
        if (!fs.existsSync(rootAbs) && !this.hasStagedChanges())
            throw new Error(`search_files: root not found: ${rootRel}`);

        const nameRe = globToRegExp(globPattern);
        const results: string[] = [];
        for (const key of this.visibleFiles(rootRel)) {
            const base = key.split("/").pop() ?? key;
            if (!nameRe.test(key) && !nameRe.test(base)) continue;
            if (contentQuery) {
                if (!isProbablyTextFile(key)) continue;
                const text = this.getEffectiveText(key);
                if (!text?.includes(contentQuery)) continue;
            }
            results.push(key);
        }

        const out = results.join("\n");
        this.tracker.log({
            type: "code_analysis",
            path: this.keyOf(rootRel),
            details: { after: out || "(no matches)", toolName: "search_files" },
            status: "executed",
        });
        return out || "(no matches)";
    }

    /** Regex search over file contents, staged changes included. */
    grep(pattern: string, opts: GrepOptions = {}): string {
        const rootRel = opts.path ?? ".";
        this.assertNotExcluded(rootRel, "grep");
        let re: RegExp;
        try {
            re = new RegExp(pattern, opts.ignoreCase ? "i" : "");
        } catch (e) {
            throw new Error(`grep: invalid regex: ${(e as Error).message}`);
        }
        const globRe = opts.glob ? globToRegExp(opts.glob) : null;
        const ctx = Math.max(0, Math.min(opts.context ?? 0, 10));

        const out: string[] = [];
        const files: string[] = [];
        let matches = 0;
        let truncated = false;

        for (const key of this.visibleFiles(rootRel)) {
            if (truncated) break;
            if (!isProbablyTextFile(key)) continue;
            const base = key.split("/").pop() ?? key;
            if (globRe && !globRe.test(key) && !globRe.test(base)) continue;
            const abs = path.join(this.root, key);
            if (
                !this.overlay.has(key) &&
                fs.existsSync(abs) &&
                fs.statSync(abs).size > this.config.maxFileSizeToRead
            )
                continue;
            const text = this.getEffectiveText(key);
            if (text === undefined) continue;

            const lines = text.split(/\r?\n/);
            const hitLines: number[] = [];
            for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) hitLines.push(i);
            if (hitLines.length === 0) continue;

            files.push(key);
            matches += hitLines.length;
            if (opts.filesOnly) continue;

            const shown = new Set<number>();
            for (const h of hitLines) {
                for (let i = Math.max(0, h - ctx); i <= Math.min(lines.length - 1, h + ctx); i++) {
                    if (shown.has(i)) continue;
                    shown.add(i);
                    const sep = i === h || hitLines.includes(i) ? ":" : "-";
                    out.push(`${key}${sep}${i + 1}${sep} ${lines[i]!.slice(0, 300)}`);
                    if (out.length >= MAX_GREP_LINES) {
                        truncated = true;
                        break;
                    }
                }
                if (truncated) break;
                if (ctx > 0) out.push("--");
            }
        }

        let result: string;
        if (opts.filesOnly) result = files.join("\n");
        else result = out.join("\n");
        if (!result) result = "(no matches)";
        else
            result += `\n\n${matches} match(es) in ${files.length} file(s)${truncated ? ` — output truncated at ${MAX_GREP_LINES} lines, narrow the search` : ""}`;

        this.tracker.log({
            type: "code_analysis",
            path: this.keyOf(rootRel),
            details: { after: result, toolName: "grep" },
            status: "executed",
        });
        return result;
    }

    analyzeCodebase(rootRel: string): string {
        const rootAbs = this.resolveSafe(rootRel);
        if (!fs.existsSync(rootAbs))
            throw new Error(`analyze_codebase: not found: ${rootRel}`);

        let dirs = 0;
        const byExt = new Map<string, number>();
        let bytes = 0;
        const walk = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, ent.name);
                const relP = path.relative(this.root, full);
                if (this.excluded(relP)) continue;
                if (ent.isDirectory()) {
                    dirs++;
                    walk(full);
                } else {
                    const ext = path.extname(ent.name).toLowerCase() || "(none)";
                    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
                    try {
                        bytes += fs.statSync(full).size;
                    } catch { }
                }
            }
        };
        if (fs.statSync(rootAbs).isDirectory()) walk(rootAbs);
        else byExt.set(path.extname(rootAbs) || "(none)", 1);

        const files = [...byExt.values()].reduce((a, b) => a + b, 0);
        const topExt = [...byExt.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([e, n]) => `${e}: ${n}`)
            .join(", ");
        const summary = `Files: ${files} | Directories: ${dirs} | Size: ${(bytes / 1024).toFixed(1)} KB\nBy extension: ${topExt}`;
        this.tracker.log({
            type: "code_analysis",
            path: this.keyOf(rootRel),
            details: { after: summary, toolName: "analyze_codebase" },
            status: "executed",
        });
        return summary;
    }

    queueShell(command: string): string {
        if (!this.config.tools.allowShellExecution)
            throw new Error("Shell execution disabled");
        this.tracker.log({
            type: "tool_execute",
            path: "shell",
            details: { command, toolName: "execute_shell" },
            status: "pending",
        });
        return `Shell queued: ${command}`;
    }
    skillRoots(): string[] {
        const extra =
            process.env.SKILLS_DIRS?.split(/[;]/)
                .map((s) => s.trim())
                .filter(Boolean) ?? [];
        return [
            ...extra,
            path.join(homedir(), ".cursor/skills-cursor"),
            path.join(homedir(), ".claude/skills"),
        ];
    }

    listSkills(): string {
        const lines: string[] = [];
        for (const root of this.skillRoots()) {
            if (!fs.existsSync(root)) continue;
            const walk = (dir: string) => {
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, ent.name);
                    if (ent.isDirectory()) walk(full);
                    else if (ent.name === "SKILL.md") lines.push(full);
                }
            };
            walk(root);
        }
        const out = lines.sort().join("\n");
        this.tracker.log({
            type: "code_analysis",
            path: "skills",
            details: { after: out || "(none)", toolName: "list_skills" },
            status: "executed",
        });
        return out || "(none)";
    }

    readSkill(skillPath: string): string {
        const abs = path.isAbsolute(skillPath)
            ? path.normalize(skillPath)
            : path.normalize(path.resolve(this.config.codebasePath, skillPath));
        const allowed = this.skillRoots().some((root) => {
            const r = path.resolve(root);
            return abs === r || abs.startsWith(r + path.sep);
        });
        if (!allowed) throw new Error("read_skill: outside skill roots");
        const text = fs.readFileSync(abs, "utf8");
        this.tracker.log({
            type: "code_analysis",
            path: abs,
            details: { after: text, toolName: "read_skill" },
            status: "executed",
        });
        return text;
    }

    applyApprovedFromTracker(): { errors: string[] } {
        const errors: string[] = [];
        const all = [...this.tracker.getActions()];

        for (const a of all.filter(
            (x) => x.type === "folder_create" && x.status === "approved",
        )) {
            try {
                fs.mkdirSync(this.resolveSafe(a.path), { recursive: true });
            } catch (e) {
                errors.push(String(e));
            }
        }

        const fileOps = all
            .filter(
                (a) =>
                    (a.type === "file_create" ||
                        a.type === "file_modify" ||
                        a.type === "file_delete") &&
                    a.status === "approved",
            )
            .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

        const lastByPath = new Map<string, ActionLog>();
        for (const a of fileOps) lastByPath.set(this.keyOf(a.path), a);

        for (const [p, a] of lastByPath) {
            try {
                if (a.type === "file_delete")
                    fs.rmSync(this.resolveSafe(p), { force: true });
                else {
                    const target = this.resolveSafe(p);
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, a.details.after ?? "", "utf8");
                }
            } catch (e) {
                errors.push(String(e));
            }
        }

        for (const a of all.filter(
            (x) => x.type === "tool_execute" && x.status === "approved",
        )) {
            const cmd = a.details.command;
            if (!cmd) continue;
            const r = spawnSync(cmd, {
                shell: true,
                cwd: this.config.codebasePath,
                encoding: "utf8",
                maxBuffer: 16 * 1024 * 1024,
            });
            if (r.status && r.status !== 0)
                errors.push(`shell exit ${r.status}: ${cmd}`);
        }

        return { errors };
    }

    clearStaging(): void {
        this.overlay.clear()
        this.deleted.clear()
    }
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
        count++;
        idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
}
