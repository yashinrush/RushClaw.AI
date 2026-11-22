import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { expandHookCommand, hookMatches, runHooks } from "../core/hooks";
import { AgentEngine } from "../core/engine";
import { defaultRushClawConfig, type HooksConfig } from "../core/config";
import { scriptedModel, tempWorkspace, type ScriptedStep } from "./helpers";

function engineWithHooks(root: string, steps: ScriptedStep[], hooks: HooksConfig, mode: "review" | "auto-edit" = "review") {
    const { model } = scriptedModel(steps);
    class E extends AgentEngine {
        override model() {
            return model as any;
        }
    }
    return new E({ root, config: { ...defaultRushClawConfig(), hooks }, model: "gemini:test", permissionMode: mode });
}

describe("hook helpers", () => {
    test("matcher is an anchored regex", () => {
        expect(hookMatches({ matcher: "edit_file|create_file", command: "x" }, "edit_file")).toBe(true);
        expect(hookMatches({ matcher: "edit", command: "x" }, "edit_file")).toBe(false);
        expect(hookMatches({ command: "x" }, "anything")).toBe(true);
    });

    test("RUSHCLAW_* variables are expanded portably", () => {
        expect(expandHookCommand("prettier --write $RUSHCLAW_CHANGED_FILES", { RUSHCLAW_CHANGED_FILES: "a.ts b.ts" })).toBe(
            "prettier --write a.ts b.ts",
        );
        expect(expandHookCommand("echo ${RUSHCLAW_FILE_PATH} $HOME", { RUSHCLAW_FILE_PATH: "x.ts" })).toBe("echo x.ts $HOME");
    });

    test("hooks receive the payload as JSON on stdin", async () => {
        const root = tempWorkspace();
        const runs = await runHooks(
            "PostApply",
            [{ command: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).files.join(',')))"` }],
            { files: ["a.ts", "b.ts"] },
            root,
        );
        expect(runs[0]!.code).toBe(0);
        expect(runs[0]!.output).toBe("a.ts,b.ts");
    });
});

describe("hooks in the engine", () => {
    test("a PreToolUse hook exiting 2 blocks the tool", async () => {
        const root = tempWorkspace({ "a.ts": "1" });
        const engine = engineWithHooks(
            root,
            [{ tool: "edit_file", input: { path: "a.ts", old_string: "1", new_string: "2" } }, { text: "ok" }],
            { preToolUse: [{ matcher: "edit_file", command: `node -e "console.error('a.ts is protected');process.exit(2)"` }] },
        );
        const results: unknown[] = [];
        engine.ui.toolResult = (_n, out) => results.push(out);
        await engine.runTurn("edit");
        expect(String(results[0])).toContain("Blocked by a PreToolUse hook");
        expect(String(results[0])).toContain("a.ts is protected");
        expect(engine.pending()).toHaveLength(0);
    });

    test("a failing PostToolUse hook is fed back to the model", async () => {
        const root = tempWorkspace({ "a.ts": "1" });
        const engine = engineWithHooks(
            root,
            [{ tool: "read_file", input: { path: "a.ts" } }, { text: "ok" }],
            { postToolUse: [{ command: `node -e "console.log('lint: 1 problem');process.exit(1)"` }] },
        );
        const results: unknown[] = [];
        engine.ui.toolResult = (_n, out) => results.push(out);
        await engine.runTurn("read");
        expect(String(results[0])).toContain("lint: 1 problem");
    });

    test("postApply hooks run with the written files (auto-edit)", async () => {
        const root = tempWorkspace({ "a.ts": "1" });
        const marker = path.join(root, "hook-ran.txt");
        const engine = engineWithHooks(
            root,
            [{ tool: "edit_file", input: { path: "a.ts", old_string: "1", new_string: "2" } }, { text: "ok" }],
            { postApply: [{ command: `node -e "require('fs').writeFileSync('hook-ran.txt', process.env.RUSHCLAW_CHANGED_FILES)"` }] },
            "auto-edit",
        );
        await engine.runTurn("edit");
        expect(fs.readFileSync(marker, "utf8")).toBe("a.ts");
    });
});
