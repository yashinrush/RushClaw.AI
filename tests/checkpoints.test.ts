import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { CheckpointStore } from "../core/checkpoints";
import { AgentEngine } from "../core/engine";
import { defaultRushClawConfig } from "../core/config";
import { scriptedModel, tempWorkspace } from "./helpers";


describe("CheckpointStore", () => {
    test("restores modified files and removes created ones", () => {
        const root = tempWorkspace({ "a.txt": "original" });
        const store = new CheckpointStore(root);
        const cp = store.begin("test");
        cp.record("a.txt");
        cp.record("new.txt");
        fs.writeFileSync(path.join(root, "a.txt"), "changed");
        fs.writeFileSync(path.join(root, "new.txt"), "created");
        expect(cp.save()).not.toBeNull();

        const res = store.undoLast()!;
        expect(res.restored).toEqual(["a.txt"]);
        expect(res.removed).toEqual(["new.txt"]);
        expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("original");
        expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
        expect(store.undoLast()).toBeNull();
    });

    test("empty checkpoints are not saved", () => {
        const store = new CheckpointStore(tempWorkspace());
        expect(store.begin("nothing").save()).toBeNull();
        expect(store.list()).toHaveLength(0);
    });
});

function testEngine(root: string, steps: Parameters<typeof scriptedModel>[0], mode: "review" | "auto-edit") {
    const { model } = scriptedModel(steps);
    class E extends AgentEngine {
        override model() {
            return model as any;
        }
    }
    return new E({ root, config: defaultRushClawConfig(), model: "gemini:test", permissionMode: mode });
}

describe("auto-edit mode", () => {
    test("writes edits immediately and /undo reverts the whole turn", async () => {
        const root = tempWorkspace({ "app.ts": "let v = 1;\n" });
        const engine = testEngine(root, [
            { tool: "edit_file", input: { path: "app.ts", old_string: "1", new_string: "2" } },
            { tool: "create_file", input: { path: "extra.ts", content: "export {};\n" } },
            { tool: "run_command", input: { command: "git status" } },
            { text: "done" },
        ], "auto-edit");

        const r = await engine.runTurn("bump v");
        expect(r.written).toEqual(["app.ts", "extra.ts"]);
        expect(fs.readFileSync(path.join(root, "app.ts"), "utf8")).toBe("let v = 2;\n");
        expect(fs.existsSync(path.join(root, "extra.ts"))).toBe(true);
        expect(engine.pending()).toHaveLength(0);

        const undo = engine.undo()!;
        expect(undo.restored).toEqual(["app.ts"]);
        expect(undo.removed).toEqual(["extra.ts"]);
        expect(fs.readFileSync(path.join(root, "app.ts"), "utf8")).toBe("let v = 1;\n");
    });

    test("review mode applies through a checkpoint too", async () => {
        const root = tempWorkspace({ "app.ts": "let v = 1;\n" });
        const engine = testEngine(root, [
            { tool: "edit_file", input: { path: "app.ts", old_string: "1", new_string: "3" } },
            { text: "done" },
        ], "review");
        await engine.runTurn("bump v");
        expect(fs.readFileSync(path.join(root, "app.ts"), "utf8")).toBe("let v = 1;\n");
        for (const a of engine.pending()) engine.tracker.updateStatus(a.id, "approved", true);
        engine.applyApproved();
        expect(fs.readFileSync(path.join(root, "app.ts"), "utf8")).toBe("let v = 3;\n");
        engine.undo();
        expect(fs.readFileSync(path.join(root, "app.ts"), "utf8")).toBe("let v = 1;\n");
    });
});
