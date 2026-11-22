import { describe, expect, test } from "bun:test";
import { AgentEngine } from "../core/engine";
import { defaultRushClawConfig } from "../core/config";
import { transcriptOf } from "../core/compact";
import { scriptedModel, tempWorkspace, type ScriptedStep } from "./helpers";

function persistentEngine(root: string, steps: ScriptedStep[], compactAtTokens = 0) {
    const { model } = scriptedModel(steps);
    class E extends AgentEngine {
        override model() {
            return model as any;
        }
    }
    const config = { ...defaultRushClawConfig(), compactAtTokens };
    return new E({ root, config, model: "gemini:test", persist: true });
}

describe("sessions", () => {
    test("each turn is saved and can be resumed by a new engine", async () => {
        const root = tempWorkspace({ "a.ts": "x" });
        const e1 = persistentEngine(root, [{ text: "first answer" }, { text: "second answer" }]);
        await e1.runTurn("Explain the a.ts file please");
        await e1.runTurn("and more");

        const list = e1.sessions.list();
        expect(list).toHaveLength(1);
        expect(list[0]!.title).toBe("Explain the a.ts file please");
        expect(list[0]!.turns).toBe(2);

        const e2 = persistentEngine(root, [{ text: "third" }]);
        e2.loadSession(e2.sessions.latest()!);
        expect(e2.sessionId).toBe(e1.sessionId);
        expect(e2.messages).toHaveLength(e1.messages.length);
        expect(e2.usage.total.calls).toBe(2);
    });

    test("reset starts a new session id", () => {
        const e = persistentEngine(tempWorkspace(), [{ text: "x" }]);
        const before = e.sessionId;
        e.reset();
        expect(e.sessionId).not.toBe(before);
    });
});

describe("compaction", () => {
    test("transcript truncates tool output", () => {
        const t = transcriptOf([
            { role: "user", content: "hi" },
            {
                role: "tool",
                content: [{ type: "tool-result", toolCallId: "1", toolName: "read_file", output: { type: "text", value: "y".repeat(5000) } }],
            } as any,
        ]);
        expect(t).toContain("### USER\nhi");
        expect(t).toContain("read_file result");
        expect(t.length).toBeLessThan(1500);
    });

    test("/compact replaces history with a summary", async () => {
        const e = persistentEngine(tempWorkspace(), [
            { text: "answer one" },
            { text: "answer two" },
            { text: "SUMMARY: user wants X; done Y" }, // used by compact()
        ]);
        await e.runTurn("one");
        await e.runTurn("two");
        const r = await e.compact();
        expect(r!.messagesBefore).toBe(4);
        expect(e.messages).toHaveLength(2);
        expect(String(e.messages[0]!.content)).toContain("SUMMARY: user wants X");
    });

    test("auto-compacts when the context passes the threshold", async () => {
        const e = persistentEngine(
            tempWorkspace(),
            [{ text: "a1" }, { text: "a2" }, { text: "SUMMARY auto" }, { text: "a3" }],
            50, // mock reports 100 input tokens per call
        );
        const infos: string[] = [];
        e.ui.info = (m) => infos.push(m);
        await e.runTurn("one");
        await e.runTurn("two"); // 2 messages before -> not compacted yet (needs > 2)
        await e.runTurn("three"); // compacts first, then answers
        expect(infos.some((m) => m.startsWith("Compacted"))).toBe(true);
        expect(String(e.messages[0]!.content)).toContain("SUMMARY auto");
    });
});
