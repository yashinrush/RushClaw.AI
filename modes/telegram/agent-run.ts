import type { Context } from "telegraf";
import { AgentEngine } from "../../core/engine.ts";
import type { Plan, PlanStep } from "../plan/types.ts";
import { stepPrompt } from "../plan/orchestrator.ts";
import { replyMd } from "./text.ts";
import { finishOrApprove } from "./approval-session.ts";
import { TelegramProgress } from "./progress.ts";

/** Tasks that take at least this long end with a separate (notifying) message. */
const NOTIFY_AFTER_MS = 20_000;

/**
 * Telegram runs without an interactive approver: allowlisted commands run,
 * other commands are queued for the Accept/Reject buttons, and edits are staged
 * for review (checkpointed when applied, so /undo works).
 */
function newEngine(mode: "agent" | "ask", progress: TelegramProgress) {
    return new AgentEngine({ mode, ui: progress.ui(), permissionMode: "review" });
}

async function notifyDone(ctx: Context, progress: TelegramProgress, label: string) {
    if (Date.now() - progress.startedAt < NOTIFY_AFTER_MS) return;
    await ctx.reply(`🔔 ${label} finished after ${progress.elapsed()}.`);
}

export async function runAsk(ctx: Context, question: string) {
    const progress = new TelegramProgress(ctx, "🔍 Researching your question…");
    await progress.start();
    const engine = newEngine("ask", progress);
    try {
        const r = await engine.runTurn(question);
        await progress.done(`✅ Done · ${engine.usage.formatTurn()}`);
        await replyMd(ctx, r.text || "(no answer)");
        await notifyDone(ctx, progress, "Ask");
    } catch (e) {
        await progress.done("❌ Failed");
        throw e;
    }
}

export async function runAgent(ctx: Context, chatId: number, goal: string) {
    const progress = new TelegramProgress(ctx, "🤖 Agent is working on your task…");
    await progress.start();
    const engine = newEngine("agent", progress);
    await engine.connectMcp();
    try {
        const r = await engine.runTurn(goal);
        await progress.done(`✅ Done · ${engine.usage.formatTurn()}`);
        if (r.text.trim()) await replyMd(ctx, r.text.trim());
        await finishOrApprove(ctx, chatId, engine, "✅ Done. No file changes were needed.");
        await notifyDone(ctx, progress, "Agent task");
    } catch (e) {
        await progress.done("❌ Failed");
        engine.rejectAll();
        throw e;
    } finally {
        await engine.close();
    }
}

export async function runPlanSteps(ctx: Context, chatId: number, plan: Plan, steps: PlanStep[]) {
    const progress = new TelegramProgress(ctx, `🧭 Executing ${steps.length} plan step(s)…`);
    await progress.start();
    const engine = newEngine("agent", progress);
    await engine.connectMcp();
    let lastText = "";
    try {
        for (const [i, step] of steps.entries()) {
            progress.log(`🔧 Step ${i + 1}/${steps.length}: ${step.title}`);
            const r = await engine.runTurn(stepPrompt(plan, step, i, steps.length));
            lastText = r.text.trim() || lastText;
        }
        await progress.done(`✅ All steps done · ${engine.usage.formatTurn()}`);
        if (lastText) await replyMd(ctx, lastText);
        await finishOrApprove(ctx, chatId, engine, "✅ All steps done. No file changes needed.");
        await notifyDone(ctx, progress, "Plan");
    } catch (e) {
        await progress.done("❌ Failed");
        engine.rejectAll();
        throw e;
    } finally {
        await engine.close();
    }
}
