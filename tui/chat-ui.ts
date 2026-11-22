import chalk from "chalk";
import { isCancel, select } from "@clack/prompts";
import type { EngineUI } from "../core/engine";
import type { Approver, PermissionAnswer, PermissionRequest } from "../core/permissions";
import { Activity } from "./activity";
import { StreamingMarkdown } from "./stream-md";
import { printToolCall, printToolError, printToolResult, toolLabel } from "./tool-display";

/** Terminal implementation of the engine's progress callbacks. */
export class CliUI implements EngineUI {
    readonly activity = new Activity();
    private label = "Thinking…";
    private readonly md = new StreamingMarkdown((s) => {
        const wasRunning = this.activity.running;
        this.activity.stop();
        process.stdout.write(s);
        if (wasRunning) this.activity.start(this.label);
    });

    turnStart(): void {
        console.log();
        this.setLabel("Thinking…");
        this.activity.start(this.label);
    }

    turnEnd(): void {
        this.md.flush();
        this.activity.stop();
    }

    private setLabel(l: string) {
        this.label = l;
        this.activity.set(l);
    }

    text(delta: string): void {
        this.setLabel("Writing…");
        this.md.push(delta);
    }

    textDone(): void {
        this.md.flush();
    }

    toolCall(name: string, input: unknown): void {
        this.md.flush();
        this.activity.stop();
        printToolCall(name, input);
        this.setLabel(`${toolLabel(name, input)}…`);
        this.activity.start(this.label);
    }

    toolResult(name: string, output: unknown): void {
        this.activity.stop();
        printToolResult(name, output);
        this.setLabel("Thinking…");
        this.activity.start(this.label);
    }

    toolError(name: string, error: unknown): void {
        this.activity.stop();
        printToolError(name, error);
        this.setLabel("Thinking…");
        this.activity.start(this.label);
    }

    info(message: string): void {
        const wasRunning = this.activity.running;
        this.activity.stop();
        console.log(chalk.yellow(`⚠️  ${message}`));
        if (wasRunning) this.activity.start(this.label);
    }

    /** Pause the spinner around an interactive prompt. */
    async pauseFor<T>(fn: () => Promise<T>): Promise<T> {
        const wasRunning = this.activity.running;
        this.activity.stop();
        try {
            return await fn();
        } finally {
            if (wasRunning) this.activity.start(this.label);
        }
    }
}

/** Asks the user (mid-turn) before running a command outside the allowlist or an MCP tool. */
export class CliApprover implements Approver {
    constructor(private readonly ui?: CliUI) { }

    async ask(req: PermissionRequest): Promise<PermissionAnswer> {
        const run = async (): Promise<PermissionAnswer> => {
            const icon = req.kind === "command" ? "🖥" : "🔌";
            console.log(`\n${chalk.yellow(icon)}  ${chalk.bold(req.title)}`);
            console.log(chalk.cyan(`   ${req.detail.split("\n").join("\n   ")}`));
            const choice = await select<PermissionAnswer>({
                message: "Allow?",
                options: [
                    { value: "yes", label: "Yes" },
                    { value: "always", label: `Yes, and don't ask again for ${req.alwaysLabel} this session` },
                    { value: "no", label: "No" },
                ],
            });
            return isCancel(choice) ? "no" : choice;
        };
        return this.ui ? this.ui.pauseFor(run) : run();
    }
}
