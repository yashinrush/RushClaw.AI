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
    .option("-c, --continue", "continue the most recent conversation in this directory")
    .option("-r, --resume [sessionId]", "resume a saved conversation (pick from a list when no id is given)")
    .action(async (prompt: string[], opts: { model?: string; autoEdit?: boolean; continue?: boolean; resume?: string | boolean }) => {
        await runAgentMode({
            model: opts.model,
            permissionMode: opts.autoEdit ? "auto-edit" : undefined,
            initialPrompt: prompt.join(" ") || undefined,
            continueLast: opts.continue,
            resume: opts.resume,
        });
    });

program.command("sessions")
    .description("list saved conversations for this directory")
    .action(async () => {
        const { SessionStore } = await import("./core/session");
        const list = new SessionStore(process.cwd()).list();
        if (!list.length) return void console.log("No saved sessions for this directory.");
        for (const s of list.slice(0, 30))
            console.log(`${s.id}  ${s.updatedAt.replace("T", " ").slice(0, 16)}  [${s.mode}] ${s.turns} turn(s)  ${s.title}`);
        console.log("\nResume with: rushclaw-build chat --resume <id>   (or --continue for the latest)");
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
    .option("-c, --continue", "continue the most recent Ask conversation")
    .action(async (question: string[], opts: { model?: string; continue?: boolean }) => {
        await runAskMode({ model: opts.model, initialPrompt: question.join(" ") || undefined, continueLast: opts.continue });
    });

await program.parseAsync(process.argv);
