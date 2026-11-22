import { Markup, type Context, type Telegraf } from "telegraf";
import { isOwner } from "./auth";
import { WELCOME } from "./constants";
import { clip, commandArg } from "./text";
import { runAgent, runAsk, runPlanSteps } from "./agent-run";
import { generatePlan } from "../plan/planner";
import { planKeyboard, planMessage, planSessions, refreshPlanUi, type PlanSession } from "./plan-session";
import { acceptSession, approvalDiff, approvalSessions } from "./approval-session";
import { canTranscribe, transcribeAudio, voiceTranscripts } from "./voice";
import { errorText } from "../../core/errors";
import { CheckpointStore } from "../../core/checkpoints";

async function fail(ctx: Context, prefix: string, err: unknown) {
    console.error(err);
    await ctx.reply(`❌ ${prefix}: ${errorText(err)}`);
}

function startAsk(ctx: Context, question: string) {
    void runAsk(ctx, question).catch((err) => fail(ctx, "Error", err));
}

function startAgent(ctx: Context, chatId: number, goal: string) {
    void runAgent(ctx, chatId, goal).catch((err) => fail(ctx, "Error", err));
}

function startPlan(ctx: Context, chatId: number, goal: string) {
    void (async () => {
        await ctx.reply("🧭 Generating a plan…");
        try {
            const plan = await generatePlan(goal);
            const session: PlanSession = { plan, selected: new Set(plan.steps.map((s) => s.id)) };
            await ctx.reply(planMessage(session), { parse_mode: "Markdown", ...planKeyboard(session) });
            planSessions.set(chatId, session);
        } catch (err) {
            await fail(ctx, "Failed to generate plan", err);
        }
    })();
}

export function registerHandlers(bot: Telegraf) {
    bot.command("start", async (ctx) => {
        if (!isOwner(ctx.from?.id ?? ctx.chat?.id)) return;
        await ctx.reply(WELCOME, { parse_mode: "Markdown" });
    });

    bot.command("ask", async (ctx) => {
        if (!isOwner(ctx.from?.id ?? ctx.chat?.id)) return;
        const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
        const q = commandArg(text, "ask");
        if (!q)
            return ctx.reply("Usage: `/ask <your question>`", {
                parse_mode: "Markdown",
            });
        startAsk(ctx, q);
    });

    bot.command("agent", async (ctx) => {
        if (!isOwner(ctx.from?.id ?? ctx.chat?.id)) return;
        const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
        const goal = commandArg(text, "agent");
        if (!goal)
            return ctx.reply("Usage: `/agent <task description>`", {
                parse_mode: "Markdown",
            });
        startAgent(ctx, ctx.chat.id, goal);
    });

    bot.command("plan", async (ctx) => {
        if (!isOwner(ctx.from?.id ?? ctx.chat?.id)) return;
        const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
        const goal = commandArg(text, "plan");

        if (!goal)
            return ctx.reply("Usage: `/plan <your goal>`", {
                parse_mode: "Markdown",
            });
        startPlan(ctx, ctx.chat.id, goal);
    });

    // ── /undo: restore the files changed by the last applied change ──
    bot.command("undo", async (ctx) => {
        if (!isOwner(ctx.from?.id ?? ctx.chat?.id)) return;
        const cp = new CheckpointStore(process.cwd()).latest();
        if (!cp) return ctx.reply("Nothing to undo.");
        const files = cp.files.map((f) => `${f.existed ? "↺ restore" : "🗑 delete"} ${f.path}`).join("\n");
        await ctx.reply(clip(`Undo "${cp.label}"?\n\n${files}`), {
            ...Markup.inlineKeyboard([
                [Markup.button.callback("↺ Undo", "undo_confirm"), Markup.button.callback("Cancel", "undo_cancel")],
            ]),
        });
    });

    bot.action("undo_confirm", async (ctx) => {
        if (!isOwner(ctx.from?.id ?? ctx.chat?.id)) return ctx.answerCbQuery();
        const res = new CheckpointStore(process.cwd()).undoLast();
        await ctx.answerCbQuery();
        if (!res) return ctx.editMessageText("Nothing to undo.");
        const errors = res.errors.length ? `\n⚠️ ${res.errors.join("\n")}` : "";
        await ctx.editMessageText(`↺ Restored ${res.restored.length}, removed ${res.removed.length} file(s).${errors}`);
    });

    bot.action("undo_cancel", async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageText("Undo cancelled.");
    });

    // ── Voice notes: transcribe, then ask what to do with the text ──
    bot.on(["voice", "audio"], async (ctx) => {
        if (!isOwner(ctx.from?.id ?? ctx.chat?.id)) return;
        const msg = ctx.message as { voice?: { file_id: string; mime_type?: string }; audio?: { file_id: string; mime_type?: string } };
        const file = msg.voice ?? msg.audio;
        if (!file) return;
        if (!canTranscribe())
            return ctx.reply("🎙 Voice notes need GEMINI_API_KEY in .env (Gemini transcribes the audio).");

        await ctx.reply("🎙 Transcribing…");
        try {
            const link = await ctx.telegram.getFileLink(file.file_id);
            const res = await fetch(link.toString());
            const audio = new Uint8Array(await res.arrayBuffer());
            const transcript = await transcribeAudio(audio, file.mime_type ?? "audio/ogg");
            if (!transcript) return ctx.reply("I couldn't hear anything in that voice note.");
            voiceTranscripts.set(ctx.chat.id, transcript);
            await ctx.reply(clip(`📝 "${transcript}"\n\nWhat should I do with it?`), {
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback("❓ Ask", "voice_ask"),
                        Markup.button.callback("🤖 Agent", "voice_agent"),
                        Markup.button.callback("🧭 Plan", "voice_plan"),
                    ],
                    [Markup.button.callback("✖ Cancel", "voice_cancel")],
                ]),
            });
        } catch (err) {
            await fail(ctx, "Transcription failed", err);
        }
    });

    bot.action(/^voice_(ask|agent|plan|cancel)$/, async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const transcript = voiceTranscripts.get(chatId);
        voiceTranscripts.delete(chatId);
        await ctx.answerCbQuery();
        const action = ctx.match[1];
        if (!transcript || action === "cancel") return ctx.editMessageText("Voice note dismissed.");
        await ctx.editMessageText(clip(`🎙 ${action === "ask" ? "Asking" : action === "agent" ? "Running agent" : "Planning"}: "${transcript}"`));
        if (action === "ask") startAsk(ctx, transcript);
        else if (action === "agent") startAgent(ctx, chatId, transcript);
        else startPlan(ctx, chatId, transcript);
    });

    bot.action(/^plan_toggle:(.+)$/, async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const s = planSessions.get(chatId);
        if (!s) return ctx.answerCbQuery();

        const id = ctx.match[1]!;
        if (s.selected.has(id)) s.selected.delete(id);
        else s.selected.add(id);

        await refreshPlanUi(ctx, s);
        await ctx.answerCbQuery();
    });

    bot.action('plan_all', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const s = planSessions.get(chatId);
        if (!s) return ctx.answerCbQuery();
        for (const step of s.plan.steps) s.selected.add(step.id);
        await refreshPlanUi(ctx, s);
        await ctx.answerCbQuery();
    });

    bot.action('plan_none', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const s = planSessions.get(chatId);
        if (!s) return ctx.answerCbQuery();
        s.selected.clear();
        await refreshPlanUi(ctx, s);
        await ctx.answerCbQuery();
    });

    bot.action('plan_proceed', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const s = planSessions.get(chatId);
        if (!s) return ctx.answerCbQuery();

        const steps = s.plan.steps.filter((step) => s.selected.has(step.id));
        if (steps.length === 0) return ctx.answerCbQuery("No steps selected");

        const { plan } = s;
        planSessions.delete(chatId);
        const list = steps.map((step, i) => `${i + 1}. ${step.title}`).join('\n');
        await ctx.editMessageText(`🚀 Executing ${steps.length} step(s)…\n\n${list}`);
        await ctx.answerCbQuery();

        void runPlanSteps(ctx, chatId, plan, steps).catch((err) => fail(ctx, "Error executing plan steps", err));
    });

    bot.action('approval_diff', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const s = approvalSessions.get(chatId);
        if (!s) return ctx.answerCbQuery();
        await ctx.answerCbQuery();
        const diff = approvalDiff(s.pending);
        await ctx.reply(clip(diff || "(No text diff available for staged changes)"));
    });

    bot.action('approval_accept', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const s = approvalSessions.get(chatId);
        if (!s) return ctx.answerCbQuery();

        approvalSessions.delete(chatId);
        const { errors, applied, shellOutputs } = await acceptSession(s);
        const shells = shellOutputs.length ? `\n\n${clip(shellOutputs.join("\n\n"), 1500)}` : "";

        if (errors.length) {
            console.error(errors);
            await ctx.editMessageText(`⚠️ Applied with some errors:\n${errors.join('\n')}${shells}`);
            await ctx.answerCbQuery('Applied with errors');
        } else {
            await ctx.editMessageText(`✅ Applied ${applied.length} file change(s). Send /undo to revert.${shells}`);
            await ctx.answerCbQuery('Applied!');
        }
    });

    bot.action('approval_reject', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId || !isOwner(ctx.from?.id ?? chatId)) return ctx.answerCbQuery();
        const s = approvalSessions.get(chatId);
        if (!s) return ctx.answerCbQuery();

        approvalSessions.delete(chatId);
        s.engine.rejectAll();

        await ctx.editMessageText('❌ All changes rejected. Nothing was applied.');
        await ctx.answerCbQuery('Rejected');
    });

}
