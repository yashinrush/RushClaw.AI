import { runChat, type ChatOptions } from "../agent/chat.ts";

/**
 * Ask Mode = the same chat engine with read-only tools: multi-turn follow-up
 * questions, streaming answers, and /save to export the conversation as Markdown.
 */
export async function runAskMode(opts: Omit<ChatOptions, "mode"> = {}) {
    await runChat({ ...opts, mode: "ask" });
}
