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
    .option("--auto-edit", "write edits immediately (checkpointed, /undo to revert) instead of reviewing diffs")
    .action(async (prompt: string[], opts: { model?: string; autoEdit?: boolean }) => {
        await runAgentMode({
            model: opts.model,
            permissionMode: opts.autoEdit ? "auto-edit" : undefined,
            initialPrompt: prompt.join(" ") || undefined,
        });
    });

program.command("undo")
    .description("restore the files changed by RushClaw's last applied turn in this directory")
    .option("-y, --yes", "don't ask for confirmation")
    .action(async (opts: { yes?: boolean }) => {
        const { CheckpointStore } = await import("./core/checkpoints");
        const { confirm, isCancel } = await import("@clack/prompts");
        const store = new CheckpointStore(process.cwd());
        const cp = store.latest();
        if (!cp) return void console.log("Nothing to undo.");
        console.log(`Last checkpoint: "${cp.label}" (${cp.createdAt})`);
        for (const f of cp.files) console.log(`  ${f.existed ? "restore" : "delete "} ${f.path}`);
        if (!opts.yes) {
            const ok = await confirm({ message: "Restore these files?", initialValue: true });
            if (isCancel(ok) || !ok) return;
        }
        const res = store.undoLast()!;
        console.log(`Restored ${res.restored.length}, removed ${res.removed.length} file(s).`);
        for (const e of res.errors) console.log(`  • ${e}`);
    });

program.command("ask")
    .description("read-only Q&A about the codebase")
    .argument("[question...]", "optional first question")
    .option("-m, --model <spec>", "model to use")
    .action(async (question: string[], opts: { model?: string }) => {
        await runAskMode({ model: opts.model, initialPrompt: question.join(" ") || undefined });
    });

await program.parseAsync(process.argv);
