import { isCancel, text, spinner } from "@clack/prompts";
import chalk from "chalk";
import { ToolLoopAgent, stepCountIs } from "ai";
import { defaultAgentConfig } from "./types";
import { ActionTracker } from "./action-tracker";
import { ToolExecutor } from "./tool-executor";
import { createAgentTools } from "./agent-tools";
import { getAgentModel } from "../../ai";
import { runApprovalFlow } from "./approval";
import { renderTerminalMarkdown } from "../../tui/terminal-md";
import { buildSystemPrompt } from "../../core/system-prompt";
import { loadMemory } from "../../core/memory";
import { printError } from "../../core/errors";

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
        instructions: buildSystemPrompt({
            mode: "agent",
            root: config.codebasePath,
            permissionMode: "review",
            memory: loadMemory(config.codebasePath),
            toolNames: Object.keys(tools),
        }),
        tools,
    });

    const s = spinner();
    s.start("Agent is thinking and analyzing task...");

    let result;
    try {
        result = await agent.generate({
            prompt: goal.trim(),
            onStepFinish: ({ toolCalls }) => {
                for (const tc of toolCalls) {
                    const preview = JSON.stringify(tc.input).slice(0, 160);
                    s.message(`Running ${chalk.cyan(String(tc.toolName))}...`);
                    console.log(
                        chalk.green("  ✓"),
                        chalk.bold(String(tc.toolName)),
                        chalk.dim(preview + (preview.length >= 160 ? "..." : "")),
                    );
                }
            },
        });
        s.stop("Agent tasks completed!");
    } catch (err: any) {
        s.stop("Agent execution failed");
        executor.clearStaging();
        printError(err, undefined, "Agent encountered an error");
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


