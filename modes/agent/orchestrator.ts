import { runChat, type ChatOptions } from "./chat";

/**
 * Agent Mode = interactive multi-turn chat with streaming output, slash
 * commands and diff review. See modes/agent/chat.ts and core/engine.ts.
 */
export async function runAgentMode(opts: Omit<ChatOptions, "mode"> = {}) {
    await runChat({ ...opts, mode: "agent" });
}
