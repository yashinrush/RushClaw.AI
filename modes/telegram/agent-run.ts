import { ToolLoopAgent, stepCountIs } from "ai";
import { getAgentModel } from "../../ai/ai.config.ts";
import { ActionTracker } from "../agent/action-tracker.ts";
import { ToolExecutor } from "../agent/tool-executor.ts";
import { createAgentTools, createReadOnlyTools } from "../agent/agent-tools.ts";
import { buildSystemPrompt, type PromptMode } from "../../core/system-prompt.ts";
import { loadMemory } from "../../core/memory.ts";
import { defaultAgentConfig, type AgentConfig } from "../agent/types.ts";
import { createWebTools } from "../plan/web-tools.ts";
import type { Plan, PlanStep } from "../plan/types.ts";
import { replyMd } from "./text.ts";
import { finishOrApprove } from "./approval-session.ts";

function readOnlyConfig(): AgentConfig {
    const c = defaultAgentConfig();
    c.tools.allowFileCreation = false;
    c.tools.allowFileModification = false;
    c.tools.allowFolderCreation = false;
    c.tools.allowShellExecution = false;
    return c;
}

function agentOptions(config: AgentConfig, maxSteps: number, mode: PromptMode = "agent", toolNames: string[] = []) {
    return {
        model: getAgentModel(),
        stopWhen: stepCountIs(maxSteps),
        instructions: buildSystemPrompt({
            mode,
            root: config.codebasePath,
            permissionMode: "review",
            memory: loadMemory(config.codebasePath),
            hasWeb: !!process.env.FIRECRAWL_API_KEY,
            toolNames,
        }),
    };
}

function extraWebTools(tracker: ActionTracker) {
    return process.env.FIRECRAWL_API_KEY ? createWebTools(tracker) : {};
}


export async function runAsk(ctx: { reply: (t: string, o?: object) => Promise<unknown> }, question: string) {
    const config = readOnlyConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    const tools = { ...createReadOnlyTools(executor), ...extraWebTools(tracker) };
    const agent = new ToolLoopAgent({
        ...agentOptions(config, 20, "ask"),
        tools,
    });

    const { text } = await agent.generate({ prompt: question });
    await replyMd(ctx, text || ("no answer"))
}

export async function runAgent(ctx: { reply: (t: string, o?: object) => Promise<unknown> }, chatId: number, goal: string) {
    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    const tools = createAgentTools(executor);
    const agent = new ToolLoopAgent({
        ...agentOptions(config, 40, "agent", Object.keys(tools)),
        tools,
    });
    const { text } = await agent.generate({ prompt: goal });
    if (text?.trim()) await replyMd(ctx, text.trim());
    await finishOrApprove(ctx, chatId, tracker, executor, '✅ Done. No file changes were needed.');
}

export async function runPlanSteps(
    ctx: { reply: (t: string, o?: object) => Promise<unknown> },
    chatId: number,
    plan: Plan,
    steps: PlanStep[],
) {
    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    const tools = { ...createAgentTools(executor), ...extraWebTools(tracker) };

    for (const step of steps) {
        await ctx.reply(`🔧 Executing: *${step.title}*`, { parse_mode: 'Markdown' });
        const prompt = [`Goal: ${plan.goal}`, `Step: ${step.title}`, step.description].join('\n');
        const agent = new ToolLoopAgent({
            ...agentOptions(config, 30, "agent", Object.keys(tools)),
            tools,
        });
        const { text } = await agent.generate({ prompt });
        if (text?.trim()) await replyMd(ctx, text.trim());
    }

    await finishOrApprove(ctx, chatId, tracker, executor, '✅ All steps done. No file changes needed.');
}