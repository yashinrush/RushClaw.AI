#!/usr/bin/env bun

import { Command } from "commander";
import { runWakeup } from "./tui/Wakeup";

const program = new Command();

program
    .name("rushclaw-build")
    .description("The CLI forRushClaw")
    .version("1.0.0");

program.command("wakeup")
    .description("show the banner and pick cli or telegram mode")
    .action(async () => {
        await runWakeup()
    });

await program.parseAsync(process.argv);