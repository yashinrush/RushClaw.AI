import { isCancel, text } from "@clack/prompts";
import chalk from "chalk";
import { ToolLoopAgent, stepCountIs } from "ai";
import { defaultAgentConfig } from "./types";
import { ActionTracker } from "./action-tracker";
import { ToolExecutor } from "./tool-executor";
import { createAgentTools } from "./agent-tools";
import { getAgentModel } from "../../ai";
import { runApprovalFlow } from "./approval";
import { renderTerminalMarkdown } from "../../tui/terminal-md";

export async function runAgentMode() {
    console.log(chalk.bold("\n🤖 Agent Mode\n"));

    const goal = await text({
        message: "What would you like the agent to do?",
        placeholder: "Concrete task for this codebase…",
    });

    if (isCancel(goal) || !goal.trim()) return;

    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);
    const tools = createAgentTools(executor);

    const agent = new ToolLoopAgent({
        model: getAgentModel(),
        stopWhen: stepCountIs(40),
        instructions: [
            `Workspace root: ${config.codebasePath}`,
            "All mutations are staged until approval.",
        ].join("\n"),
        tools,
    });

    let result;
    try {
        result = await agent.generate({
            prompt: goal.trim(),
            onStepFinish: ({ toolCalls }) => {
                for (const tc of toolCalls) {
                    const preview = JSON.stringify(tc.input).slice(0, 160);
                    console.log(
                        chalk.green("  ✓"),
                        chalk.bold(String(tc.toolName)),
                        chalk.dim(preview + (preview.length >= 160 ? "..." : "")),
                    );
                }
            },
        });
    } catch (err: any) {
        executor.clearStaging();
        const msg = err?.message || String(err);
        if (msg.includes("Rate limit exceeded") || msg.includes("429")) {
            console.log(chalk.red("\n❌ Rate limit exceeded: OpenRouter free tier daily limit (50 requests/day) reached."));
            console.log(chalk.yellow("👉 Suggestions:"));
            console.log(chalk.dim("   1. Switch OPENROUTER_DEFAULT_MODEL in .env (e.g. meta-llama/llama-3.3-70b-instruct:free or google/gemini-2.0-flash-lite-preview:free)"));
            console.log(chalk.dim("   2. Add credits to OpenRouter to raise the limit to 1000 requests/day"));
            console.log(chalk.dim("   3. Or wait for the daily quota reset.\n"));
        } else {
            console.log(chalk.red(`\n❌ Agent encountered an error: ${msg}\n`));
        }
        return;
    }

    if (result.text?.trim()) console.log(renderTerminalMarkdown(result.text));

    const ok = await runApprovalFlow(tracker);
    if (!ok) return executor.clearStaging();

    const { errors } = executor.applyApprovedFromTracker();

    if (errors.length) {
        console.log(chalk.red("\nSome operations reported errors:\n"));
        for (const e of errors) console.log(chalk.red(`  • ${e}`));
    }
    else {
        console.log(chalk.green('\n✓ Applied.\n'));
    }

    executor.clearStaging();
}


