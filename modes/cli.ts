import { select, isCancel } from "@clack/prompts";
import { runAgentMode } from "./agent/orchestrator";
import { runAskMode } from "./ask/orchestrator";
import { runPlanMode } from "./plan/orchestrator";

export async function runCliMode() {
    while (true) {
        const mode = await select({
            message: "Choose CLI sub-mode",
            options: [
                { value: "agent", label: "Agent Mode", hint: "multi-turn chat that edits code & runs checks" },
                { value: "plan", label: "Plan Mode", hint: "research → step plan → execute" },
                { value: "ask", label: "Ask Mode", hint: "read-only Q&A about the codebase" },
                { value: "back", label: "← Back to main menu" },
            ]
        });

        if (isCancel(mode) || mode === "back") return;

        if (mode === "agent") await runAgentMode();
        else if (mode === "ask") await runAskMode();
        else if (mode === "plan") await runPlanMode();
    }
}
