import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/** Temporary workspace with the given files. */
export function tempWorkspace(files: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rushclaw-test-"));
    for (const [rel, content] of Object.entries(files)) {
        const p = path.join(dir, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
    }
    return dir;
}

const usage = {
    inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 20, text: 20, reasoning: 0 },
};

export type ScriptedStep =
    | { text: string }
    | { tool: string; input: Record<string, unknown> };

/**
 * A mock model that answers each call with the next scripted step:
 * either a tool call or a final text reply (streamed in small chunks).
 */
export function scriptedModel(steps: ScriptedStep[]) {
    let call = 0;
    const model = new MockLanguageModelV4({
        doStream: async () => {
            const step = steps[Math.min(call, steps.length - 1)]!;
            call++;
            const chunks: any[] = [{ type: "stream-start", warnings: [] }];
            if ("text" in step) {
                chunks.push({ type: "text-start", id: "t" });
                for (const piece of step.text.match(/[\s\S]{1,8}/g) ?? [])
                    chunks.push({ type: "text-delta", id: "t", delta: piece });
                chunks.push({ type: "text-end", id: "t" });
                chunks.push({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage });
            } else {
                chunks.push({
                    type: "tool-call",
                    toolCallId: `call_${call}`,
                    toolName: step.tool,
                    input: JSON.stringify(step.input),
                });
                chunks.push({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage });
            }
            return { stream: simulateReadableStream({ chunks }) } as any;
        },
    });
    return { model, calls: () => call };
}
