import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { TelegramProgress } from "../modes/telegram/progress";
import { acceptSession, approvalSessions, approvalSummary, finishOrApprove } from "../modes/telegram/approval-session";
import { AgentEngine } from "../core/engine";
import { defaultRushClawConfig } from "../core/config";
import { scriptedModel, tempWorkspace } from "./helpers";

function fakeCtx() {
    const sent: string[] = [];
    const edits: string[] = [];
    const ctx: any = {
        chat: { id: 42 },
        reply: async (text: string) => {
            sent.push(text);
            return { message_id: sent.length };
        },
        telegram: {
            editMessageText: async (_chat: number, _id: number, _inline: unknown, text: string) => {
                edits.push(text);
            },
        },
    };
    return { ctx, sent, edits };
}

describe("TelegramProgress", () => {
    test("edits one message in place, throttled", async () => {
        const { ctx, sent, edits } = fakeCtx();
        const p = new TelegramProgress(ctx, "🤖 Working");
        await p.start();
        const ui = p.ui();
        ui.toolCall!("read_file", { path: "a.ts" });
        ui.toolCall!("grep", { pattern: "x" });
        ui.toolCall!("edit_file", { path: "a.ts" });
        await p.done("✅ Done");
        expect(sent).toHaveLength(1); // only the initial message
        const last = edits[edits.length - 1]!;
        expect(last).toContain("⏺ Read a.ts");
        expect(last).toContain("⏺ Grep /x/");
        expect(last).toContain("⏺ Edit a.ts");
        expect(last).toContain("✅ Done");
        expect(edits.length).toBeLessThanOrEqual(2); // throttled, not one edit per line
    });
});

describe("Telegram approval", () => {
    test("Accept applies staged changes through the engine (checkpointed)", async () => {
        const root = tempWorkspace({ "a.ts": "let x = 1;\n" });
        const { model } = scriptedModel([
            { tool: "edit_file", input: { path: "a.ts", old_string: "1", new_string: "2" } },
            { text: "done" },
        ]);
        class E extends AgentEngine {
            override model() {
                return model as any;
            }
        }
        const engine = new E({ root, config: defaultRushClawConfig(), model: "gemini:test" });
        await engine.runTurn("bump");

        const { ctx, sent } = fakeCtx();
        await finishOrApprove(ctx, 42, engine, "no changes");
        expect(sent[0]).toContain("📄 a.ts (file modify) +1 -1");
        expect(approvalSummary(engine.pending())).toContain("Total: 1 change(s)");

        const session = approvalSessions.get(42)!;
        const res = await acceptSession(session);
        expect(res.applied).toEqual(["a.ts"]);
        expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("let x = 2;\n");
        expect(engine.checkpoints.latest()?.files[0]?.path).toBe("a.ts");
    });
});
