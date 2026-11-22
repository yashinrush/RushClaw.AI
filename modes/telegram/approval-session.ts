import { Markup, type Context } from 'telegraf';
import type { AgentEngine } from '../../core/engine.ts';
import type { ActionLog } from '../agent/types.ts';
import { changeStats, composeBeforeAfter, formatPatch } from '../agent/diff-view.ts';
import { clip } from './text.ts';

export interface ApprovalSession {
    engine: AgentEngine;
    pending: ActionLog[];
}

export const approvalSessions = new Map<number, ApprovalSession>();

function groupPending(pending: ActionLog[]) {
    const files = new Map<string, ActionLog[]>();
    const shells: ActionLog[] = [];
    for (const a of pending) {
        if (a.type === 'tool_execute') shells.push(a);
        else {
            if (!files.has(a.path)) files.set(a.path, []);
            files.get(a.path)!.push(a);
        }
    }
    return { files, shells };
}

export function approvalSummary(pending: ActionLog[]): string {
    const { files, shells } = groupPending(pending);
    const fileLines = [...files].map(([path, actions]) => {
        const sorted = [...actions].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        const { before, after } = composeBeforeAfter(sorted);
        const { added, removed } = changeStats(before, after);
        const types = [...new Set(actions.map((a) => a.type.replace(/_/g, ' ')))].join(', ');
        return `📄 ${path} (${types}) +${added} -${removed}`;
    });
    const shellLines = shells.map((s) => `🖥 Shell: ${s.details.command}`);
    return ['Staged changes — review before applying', '', ...fileLines, ...shellLines, '', `Total: ${pending.length} change(s)`].join('\n');
}

export function approvalDiff(pending: ActionLog[]): string {
    const { files, shells } = groupPending(pending);
    const parts: string[] = [];
    for (const [filePath, actions] of files) {
        const sorted = [...actions].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        const { before, after } = composeBeforeAfter(sorted);
        parts.push(clip(formatPatch(filePath, before, after), 1500));
    }
    for (const s of shells) parts.push(`🖥 Shell: ${s.details.command}`);
    return parts.join('\n\n').trim();
}

/** Show the staged changes with Diff / Accept / Reject buttons. */
export async function finishOrApprove(
    ctx: Context,
    chatId: number,
    engine: AgentEngine,
    noChangesMsg: string,
) {
    const pending = engine.pending();
    if (pending.length === 0) {
        await ctx.reply(noChangesMsg);
        return;
    }
    approvalSessions.set(chatId, { engine, pending });
    await ctx.reply(approvalSummary(pending), {
        ...Markup.inlineKeyboard([
            [Markup.button.callback('📋 Show Diff', 'approval_diff')],
            [
                Markup.button.callback('✅ Accept All', 'approval_accept'),
                Markup.button.callback('❌ Reject All', 'approval_reject'),
            ],
        ]),
    });
}

/** Apply everything in the session (checkpointed; postApply hooks run). */
export async function acceptSession(s: ApprovalSession) {
    for (const a of s.pending) s.engine.tracker.updateStatus(a.id, 'approved', true);
    const res = s.engine.applyApproved();
    await s.engine.runPostApplyHooks(res.applied);
    return res;
}
