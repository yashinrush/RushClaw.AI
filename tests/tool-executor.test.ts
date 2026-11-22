import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { ToolExecutor, globToRegExp } from "../modes/agent/tool-executor";
import { ActionTracker } from "../modes/agent/action-tracker";
import { defaultAgentConfig } from "../modes/agent/types";
import { commandFamily, isCommandAllowed, PermissionGate } from "../core/permissions";
import { DEFAULT_ALLOWED_COMMANDS, mergeConfig, defaultRushClawConfig } from "../core/config";
import { tempWorkspace } from "./helpers";

function executor(files: Record<string, string>) {
    const root = tempWorkspace(files);
    const tracker = new ActionTracker();
    const ex = new ToolExecutor(tracker, defaultAgentConfig(root, ["node_modules", ".git"]));
    return { root, tracker, ex };
}

describe("path safety", () => {
    test("paths outside the workspace are rejected", () => {
        const { ex, root } = executor({ "a.ts": "x" });
        expect(() => ex.readFile("../outside.txt")).toThrow("escapes workspace");
        expect(() => ex.createFile("../../evil.sh", "x")).toThrow("escapes workspace");
        expect(() => ex.readFile(path.join(path.dirname(root), "x.txt"))).toThrow("escapes workspace");
    });

    test(".env files are always excluded", () => {
        const { ex } = executor({ ".env": "KEY=secret", ".env.local": "x", "src/a.ts": "x" });
        expect(() => ex.readFile(".env")).toThrow("excluded");
        expect(() => ex.readFile(".env.local")).toThrow("excluded");
        expect(ex.grep("secret")).toBe("(no matches)");
        expect(ex.listFiles(".", true)).not.toContain(".env");
    });

    test("absolute and relative spellings share staged state", () => {
        const { ex, root } = executor({ "a.ts": "one" });
        ex.editFile(path.join(root, "a.ts"), "one", "two");
        expect(ex.getEffectiveText("a.ts")).toBe("two");
        expect(ex.stagedPaths()).toEqual(["a.ts"]);
    });
});

describe("edit_file", () => {
    test("requires a unique match unless replace_all", () => {
        const { ex } = executor({ "a.ts": "x = 1;\ny = 1;\n" });
        expect(() => ex.editFile("a.ts", "= 1;", "= 2;")).toThrow("matches 2 places");
        expect(ex.editFile("a.ts", "= 1;", "= 2;", true)).toContain("replaced 2");
        expect(ex.getEffectiveText("a.ts")).toBe("x = 2;\ny = 2;\n");
    });

    test("helpful errors for missing text, missing file, no-op", () => {
        const { ex } = executor({ "a.ts": "hello" });
        expect(() => ex.editFile("a.ts", "bye", "x")).toThrow("not found in a.ts");
        expect(() => ex.editFile("b.ts", "x", "y")).toThrow("file not found");
        expect(() => ex.editFile("a.ts", "hello", "hello")).toThrow("identical");
    });

    test("$ patterns in new_string are inserted literally", () => {
        const { ex } = executor({ "a.ts": "price" });
        ex.editFile("a.ts", "price", "cost: $& $1");
        expect(ex.getEffectiveText("a.ts")).toBe("cost: $& $1");
    });

    test("CRLF files accept LF old_string", () => {
        const { ex } = executor({ "w.ts": "a\r\nb\r\nc\r\n" });
        ex.editFile("w.ts", "a\nb", "A\nB");
        expect(ex.getEffectiveText("w.ts")).toBe("A\r\nB\r\nc\r\n");
    });
});

describe("staged-aware reads", () => {
    test("read/list/search/grep see staged creates and deletes", () => {
        const { ex } = executor({ "src/old.ts": "legacy", "src/keep.ts": "keep" });
        ex.createFile("src/new.ts", "fresh needle");
        ex.deleteFile("src/old.ts");
        expect(ex.readFile("src/new.ts")).toContain("fresh needle");
        expect(() => ex.readFile("src/old.ts")).toThrow("staged for deletion");
        const list = ex.listFiles("src", false);
        expect(list).toContain("new.ts (staged)");
        expect(list).not.toContain("old.ts");
        expect(ex.searchFiles(".", "**/*.ts")).toBe("src/keep.ts\nsrc/new.ts");
        expect(ex.grep("needle", { filesOnly: true })).toBe("src/new.ts\n\n1 match(es) in 1 file(s)");
    });

    test("read_file paging", () => {
        const { ex } = executor({ "big.txt": Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n") });
        const out = ex.readFile("big.txt", 3, 2);
        expect(out).toStartWith("L3\nL4");
        expect(out).toContain("showing lines 3-4 of 10");
    });

    test("grep context lines and glob filter", () => {
        const { ex } = executor({ "a.ts": "one\ntwo\nthree\n", "b.md": "two" });
        const out = ex.grep("two", { glob: "*.ts", context: 1 });
        expect(out).toContain("a.ts-1- one");
        expect(out).toContain("a.ts:2: two");
        expect(out).toContain("a.ts-3- three");
        expect(out).not.toContain("b.md");
    });

    test("apply writes the last staged version of each file", () => {
        const { ex, tracker, root } = executor({ "a.ts": "v1" });
        ex.editFile("a.ts", "v1", "v2");
        ex.editFile("a.ts", "v2", "v3");
        ex.createFile("dir/n.ts", "new");
        for (const a of tracker.getPendingMutations()) tracker.updateStatus(a.id, "approved", true);
        const r = ex.applyApprovedFromTracker();
        expect(r.applied.sort()).toEqual(["a.ts", "dir/n.ts"]);
        expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("v3");
        expect(fs.readFileSync(path.join(root, "dir/n.ts"), "utf8")).toBe("new");
    });
});

describe("globToRegExp", () => {
    test("supports * ** and ?", () => {
        expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
        expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
        expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
        expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
        expect(globToRegExp("?.md").test("a.md")).toBe(true);
    });
});

describe("command allowlist", () => {
    test("prefix match with word boundary", () => {
        expect(isCommandAllowed("bun test", DEFAULT_ALLOWED_COMMANDS)).toBe(true);
        expect(isCommandAllowed("bun test tests/a.test.ts", DEFAULT_ALLOWED_COMMANDS)).toBe(true);
        expect(isCommandAllowed("bun testx", DEFAULT_ALLOWED_COMMANDS)).toBe(false);
        expect(isCommandAllowed("rm -rf .", DEFAULT_ALLOWED_COMMANDS)).toBe(false);
    });

    test("shell operators and --output are never auto-allowed", () => {
        for (const c of ["git status; rm -rf .", "git log | sh", "git diff > x", "ls && curl x", "git show $(whoami)", "git diff --output=x"])
            expect(isCommandAllowed(c, DEFAULT_ALLOWED_COMMANDS)).toBe(false);
    });

    test("command families for 'always allow'", () => {
        expect(commandFamily("npm run build -- --prod")).toBe("npm run");
        expect(commandFamily("pytest -x tests")).toBe("pytest");
    });

    test("permission gate remembers 'always'", async () => {
        let asked = 0;
        const gate = new PermissionGate({ ask: async () => (asked++, "always") });
        const req = { kind: "command" as const, title: "t", detail: "d", alwaysKey: "cmd:npm run", alwaysLabel: "npm run" };
        expect(await gate.check(req)).toBe("allowed");
        expect(await gate.check(req)).toBe("allowed");
        expect(asked).toBe(1);
        expect(await new PermissionGate().check(req)).toBe("no-approver");
    });
});

describe("config", () => {
    test("layers merge; hooks / mcpServers / pricing merge by key", () => {
        const c = mergeConfig(
            defaultRushClawConfig(),
            { maxSteps: 10, pricing: { a: { input: 1, output: 2 } }, mcpServers: { x: { command: "x" } } },
            { maxSteps: 20, pricing: { b: { input: 3, output: 4 } }, permissionMode: "nonsense", $comment: "ignored" },
        );
        expect(c.maxSteps).toBe(20);
        expect(Object.keys(c.pricing)).toEqual(["a", "b"]);
        expect(Object.keys(c.mcpServers)).toEqual(["x"]);
        expect(c.permissionMode).toBe("review");
        expect((c as any).$comment).toBeUndefined();
    });
});
