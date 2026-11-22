#!/usr/bin/env bun

import { Command } from "commander";
import { runWakeup } from "./tui/wakeup";
import { runAgentMode } from "./modes/agent/orchestrator";
import { runAskMode } from "./modes/ask/orchestrator";
import { loadExtraEnv } from "./core/env";
import { VERSION } from "./core/version";

// API keys also come from ~/.rushclaw/.env and RushClaw's own .env, so the
// globally linked CLI works inside any project.
if (process.env.RUSHCLAW_NO_EXTRA_ENV !== "1") loadExtraEnv(import.meta.dir);

const program = new Command();

program
    .name("rushclaw-build")
    .description("RushClaw — an autonomous coding agent for your terminal")
    .version(VERSION)
    // root options must come before a subcommand, so `chat -m x` stays the chat's option
    .enablePositionalOptions()
    .option("-p, --print <prompt>", "headless: run one task non-interactively and print the result (\"-\" reads the prompt from stdin)")
    .option("-y, --yes", "headless: apply file edits (otherwise they are only shown)")
    .option("-o, --output <format>", "headless: text | json", "text")
    .option("-m, --model <spec>", "headless: model to use")
    .option("--max-steps <n>", "headless: max tool-loop steps", (v) => parseInt(v, 10))
    .option("-c, --continue", "headless: continue the most recent conversation")
    .option("--read-only", "headless: Ask mode (no edits or commands)")
    .option("--stdin", "headless: append piped stdin to the prompt")
    .action(async (opts: {
        print?: string; yes?: boolean; output?: string; model?: string; maxSteps?: number;
        continue?: boolean; readOnly?: boolean; stdin?: boolean;
    }) => {
        if (opts.print === undefined) return runWakeup();
        const { runHeadless } = await import("./modes/headless");
        const code = await runHeadless({
            prompt: opts.print,
            yes: opts.yes,
            output: opts.output === "json" ? "json" : "text",
            model: opts.model,
            maxSteps: opts.maxSteps,
            continueLast: opts.continue,
            readOnly: opts.readOnly,
            stdin: opts.stdin,
        });
        process.exitCode = code;
    });

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
