import chalk from "chalk";
import { confirm, isCancel, text } from "@clack/prompts";
import { AgentEngine } from "../../core/engine.ts";
import { printError } from "../../core/errors.ts";
import { CliApprover, CliUI } from "../../tui/chat-ui.ts";
import { reviewStagedChanges } from "../agent/chat.ts";
import { generatePlan } from "./planner.ts";
import { printPlan, selectSteps } from "./selection.ts";
import type { Plan, PlanStep } from "./types.ts";

export function stepPrompt(plan: Plan, step: PlanStep, index: number, total: number): string {
    return [
        `Overall goal: ${plan.goal}`,
        plan.researchSummary ? `Research summary: ${plan.researchSummary}` : "",
        `Execute step ${index + 1} of ${total}: ${step.title}`,
        step.description,
        step.hints?.length ? `Hints:\n${step.hints.map((h) => `- ${h}`).join("\n")}` : "",
        "Do only this step (earlier steps are already done in this conversation). Finish with a one-paragraph summary of what you changed.",
    ]
        .filter(Boolean)
        .join("\n\n");
}

export async function runPlanMode(): Promise<void> {
    console.log(chalk.bold("\n🧭 Plan Mode\n"));

    const goal = await text({ message: "What is your goal?" });
    if (isCancel(goal) || !goal.trim()) return;

    let plan: Plan;
    try {
        plan = await generatePlan(goal);
    } catch (err: any) {
        printError(err, undefined, "Error drafting plan");
        return;
    }

    printPlan(plan);

    const selected = await selectSteps(plan);
    if (selected.length === 0) return;

    const proceed = await confirm({
        message: `Execute ${selected.length} step(s)`,
        initialValue: true,
    });
    if (isCancel(proceed) || !proceed) return;

    // All steps run in ONE conversation, so later steps know what earlier ones did.
    const ui = new CliUI();
    const engine = new AgentEngine({ approver: new CliApprover(ui), ui, persist: true });
    await engine.connectMcp();

    try {
        for (const [i, step] of selected.entries()) {
            console.log(chalk.bold(`\n🔧 Step ${i + 1}/${selected.length}: ${step.title}`));
            const ac = new AbortController();
            const onSigint = () => ac.abort();
            process.on("SIGINT", onSigint);
            ui.turnStart();
            try {
                const r = await engine.runTurn(stepPrompt(plan, step, i, selected.length), ac.signal);
                ui.turnEnd();
                if (r.written.length) console.log(chalk.green(`✓ Wrote ${r.written.join(", ")}`));
                if (r.aborted) {
                    console.log(chalk.yellow("⏹  Interrupted — remaining steps skipped."));
                    break;
                }
            } catch (err) {
                ui.turnEnd();
                printError(err, engine.modelSpec, `Error running step "${step.title}"`);
                break;
            } finally {
                process.off("SIGINT", onSigint);
            }
        }

        await reviewStagedChanges(engine);
        console.log(chalk.dim(`  ↳ ${engine.usage.formatSummary(engine.config.pricing).split("\n")[0]}`));
        console.log(chalk.dim(`  Continue this work in chat: rushclaw-build chat --resume ${engine.sessionId}\n`));
    } finally {
        if (engine.pending().length) engine.rejectAll();
        await engine.close();
    }
}
