import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentEngine, type EngineOptions } from "../core/engine";
import { defaultRushClawConfig } from "../core/config";
import { scriptedModel, tempWorkspace, type ScriptedStep } from "./helpers";

function engineWith(steps: ScriptedStep[], opts: EngineOptions = {}) {
    const root = opts.root ?? tempWorkspace({ "src/app.ts": "export const greeting = 'hello';\n" });
    const { model, calls } = scriptedModel(steps);
    class TestEngine extends AgentEngine {
        override model() {
            return model as any;
        }
    }
    const events: string[] = [];
    const engine = new TestEngine({
        root,
        config: defaultRushClawConfig(),
        model: "gemini:test",
        ...opts,
        ui: {
            text: (d) => events.push(`text:${d}`),
            toolCall: (n) => events.push(`call:${n}`),
            toolResult: (n) => events.push(`result:${n}`),
            toolError: (n, e) => events.push(`error:${n}:${(e as Error)?.message}`),
        },
    });
    return { engine, root, events, calls };
}

describe("AgentEngine", () => {
    test("streams text, runs tools, stages edits and keeps history", async () => {
        const { engine, root, events } = engineWith([
            { tool: "edit_file", input: { path: "src/app.ts", old_string: "'hello'", new_string: "'hi there'" } },
            { text: "I changed the greeting." },
        ]);

        const r = await engine.runTurn("change the greeting");
        expect(r.text).toBe("I changed the greeting.");
        expect(events).toContain("call:edit_file");
        expect(events).toContain("result:edit_file");
        expect(events.filter((e) => e.startsWith("text:")).length).toBeGreaterThan(1); // streamed

        // staged, not on disk yet
        expect(fs.readFileSync(path.join(root, "src/app.ts"), "utf8")).toContain("'hello'");
        expect(engine.pending()).toHaveLength(1);

        // history: user, assistant(tool call), tool result, assistant(text)
        expect(engine.messages[0]!.role).toBe("user");
        expect(engine.messages.length).toBeGreaterThanOrEqual(3);
        expect(engine.usage.total.calls).toBe(2);

        for (const a of engine.pending()) engine.tracker.updateStatus(a.id, "approved", true);
        const res = engine.applyApproved();
        expect(res.applied).toEqual(["src/app.ts"]);
        expect(fs.readFileSync(path.join(root, "src/app.ts"), "utf8")).toContain("'hi there'");
        expect(engine.pending()).toHaveLength(0);
    });

    test("rejected changes are reported to the model on the next turn", async () => {
        const { engine } = engineWith([
            { tool: "create_file", input: { path: "notes.md", content: "# notes" } },
            { text: "Created notes.md" },
            { text: "ok" },
        ]);
        await engine.runTurn("make notes");
        const res = engine.rejectAll();
        expect(res.rejected).toEqual(["notes.md"]);
        await engine.runTurn("next");
        const lastUser = [...engine.messages].reverse().find((m) => m.role === "user")!;
        expect(String(lastUser.content)).toContain("REJECTED");
    });

    test("tool errors are surfaced, not thrown", async () => {
        const { engine, events } = engineWith([
            { tool: "edit_file", input: { path: "src/app.ts", old_string: "does-not-exist", new_string: "x" } },
            { text: "That edit failed." },
        ]);
        await engine.runTurn("edit");
        expect(events.some((e) => e.startsWith("error:edit_file:") && e.includes("not found"))).toBe(true);
    });

    test("ask mode has no write tools", () => {
        const { engine } = engineWith([{ text: "x" }], { mode: "ask" });
        const names = Object.keys(engine.tools());
        expect(names).toContain("grep");
        expect(names).not.toContain("edit_file");
        expect(names).not.toContain("run_command");
    });
});
