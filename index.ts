#!/usr/bin/env bun

import { Command } from "commander";
import { runWakeup } from "./tui/wakeup";
import { runAgentMode } from "./modes/agent/orchestrator";
import { runAskMode } from "./modes/ask/orchestrator";

const program = new Command();

program
    .name("rushclaw-build")
    .description("RushClaw — an autonomous coding agent for your terminal")
    .version("1.1.0");

program.command("wakeup")
    .description("show the banner and pick cli or telegram mode")
    .action(async () => {
        await runWakeup()
    });

program.command("chat")
    .description("start an interactive agent chat in the current directory")
    .argument("[prompt...]", "optional first message")
    .option("-m, --model <spec>", "model, e.g. gemini:gemini-3.5-flash-lite or openrouter:openrouter/auto")
    .action(async (prompt: string[], opts: { model?: string }) => {
        await runAgentMode({
            model: opts.model,
            initialPrompt: prompt.join(" ") || undefined,
        });
    });

program.command("ask")
    .description("read-only Q&A about the codebase")
    .argument("[question...]", "optional first question")
    .option("-m, --model <spec>", "model to use")
    .action(async (question: string[], opts: { model?: string }) => {
        await runAskMode({ model: opts.model, initialPrompt: question.join(" ") || undefined });
    });

await program.parseAsync(process.argv);
