import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { AgentEngine } from "./engine";
import { createReadOnlyTools } from "../modes/agent/agent-tools";
import { createWebTools } from "../modes/plan/web-tools";
import { buildSystemPrompt } from "./system-prompt";
import { toolLabel } from "../tui/tool-display";

/**
 * The `task` tool: the main agent hands a focused research question to a
 * read-only sub-agent. The sub-agent's file reads and searches never enter the
 * main conversation — only its final report does — which keeps the main
 * context small on big codebases.
 */
export function createTaskTool(engine: AgentEngine) {
    return tool({
        description: [
            "Launch a read-only sub-agent to research the codebase and report back.",
            "Use it for broad or multi-file exploration, e.g. 'Find every place auth tokens are validated and explain the flow' or 'Which tests cover the payment module?'.",
            "Write a self-contained prompt: the sub-agent can't see this conversation. Say exactly what to find and what to include in the report (file paths, line numbers, snippets).",
            "It cannot edit files. Don't use it for a single known file — just read_file it.",
        ].join("\n"),
        inputSchema: z.object({
            description: z.string().describe("3-6 word summary, e.g. 'Locate auth middleware'"),
            prompt: z.string().describe("Detailed, self-contained research task"),
        }),
        execute: async ({ description, prompt }, { abortSignal }) => {
            const tools = {
                ...createReadOnlyTools(engine.executor),
                ...(engine.hasWeb ? createWebTools(engine.tracker) : {}),
            };
            const agent = new ToolLoopAgent({
                model: engine.model(),
                instructions: buildSystemPrompt({
                    mode: "subagent",
                    root: engine.root,
                    memory: engine.memory,
                }),
                tools,
                stopWhen: stepCountIs(engine.config.subagentMaxSteps),
            });
            const r = await agent.generate({
                prompt,
                abortSignal,
                onStepFinish: (step) => {
                    engine.usage.addStep(step.usage, step.response?.modelId);
                    for (const tc of step.toolCalls) {
                        if (tc) engine.ui.subagentStep?.(description, toolLabel(tc.toolName, tc.input));
                    }
                },
            });
            return r.text?.trim() || "(The sub-agent finished without a report. Try a more specific prompt.)";
        },
    });
}
