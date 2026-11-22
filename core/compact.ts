import { generateText, type LanguageModel, type ModelMessage } from "ai";
import type { UsageLike } from "./usage";

const COMPACT_SYSTEM = `You compress coding-agent conversations so the work can continue in a fresh context window. You write precise, information-dense summaries. Never invent details.`;

const COMPACT_REQUEST = `Summarize the conversation transcript above so another instance of the agent can continue seamlessly. Use these sections:

1. **User's goal(s)** — what the user asked for, including later changes of direction and explicit preferences.
2. **Work done** — files read/created/edited (with paths) and the key decisions; what was applied, rejected or undone by the user.
3. **Important code facts** — function/file names, APIs, data shapes, commands, errors and their fixes that will matter later. Include short code snippets only if essential.
4. **Current state** — what is finished, what is in progress, test/build status.
5. **Next steps** — the remaining tasks, in order.

Be concise but complete; prefer bullet points.`;

const MAX_TOOL_CHARS = 600;
const MAX_TRANSCRIPT_CHARS = 400_000;

function clip(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + ` …[${s.length - n} chars omitted]` : s;
}

function partText(part: any): string {
    switch (part?.type) {
        case "text":
            return part.text ?? "";
        case "image":
        case "file":
            return "[attachment]";
        case "tool-call":
            return `→ called ${part.toolName}(${clip(JSON.stringify(part.input ?? part.args ?? {}), 300)})`;
        case "tool-result": {
            const out = part.output?.value ?? part.output ?? part.result;
            return `← ${part.toolName} result: ${clip(typeof out === "string" ? out : JSON.stringify(out), MAX_TOOL_CHARS)}`;
        }
        case "reasoning":
            return "";
        default:
            return "";
    }
}

/**
 * Plain-text transcript with tool traffic truncated. Summarizing this (instead
 * of replaying the raw messages) works even when the raw history is already too
 * big for the model.
 */
export function transcriptOf(messages: ModelMessage[]): string {
    const lines: string[] = [];
    for (const m of messages) {
        const body =
            typeof m.content === "string"
                ? m.content
                : (m.content as any[]).map(partText).filter(Boolean).join("\n");
        if (!body.trim()) continue;
        const who = m.role === "user" ? "USER" : m.role === "assistant" ? "AGENT" : m.role === "tool" ? "TOOL" : "SYSTEM";
        lines.push(`### ${who}\n${body.trim()}`);
    }
    let t = lines.join("\n\n");
    if (t.length > MAX_TRANSCRIPT_CHARS) t = "…[earliest part omitted]…\n" + t.slice(t.length - MAX_TRANSCRIPT_CHARS);
    return t;
}

export async function summarizeConversation(
    model: LanguageModel,
    messages: ModelMessage[],
    focus?: string,
): Promise<{ summary: string; usage: UsageLike | undefined; modelId?: string }> {
    const r = await generateText({
        model,
        system: COMPACT_SYSTEM,
        prompt: `<transcript>\n${transcriptOf(messages)}\n</transcript>\n\n${COMPACT_REQUEST}${focus ? `\n\nPay special attention to: ${focus}` : ""}`,
    });
    return { summary: r.text.trim(), usage: r.usage, modelId: r.response?.modelId };
}

/** The two messages that replace the history after compaction. */
export function compactedHistory(summary: string, todos: { content: string; status: string }[]): ModelMessage[] {
    const todoBlock = todos.length
        ? `\n\nCurrent todo list:\n${todos.map((t) => `- [${t.status}] ${t.content}`).join("\n")}`
        : "";
    return [
        {
            role: "user",
            content: `This session continues an earlier conversation that was compacted to save context. Summary of everything so far:\n\n${summary}${todoBlock}`,
        },
        {
            role: "assistant",
            content: "Understood — I have the context from the summary and will continue from there.",
        },
    ];
}
