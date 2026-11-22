import { select, isCancel } from "@clack/prompts";
import chalk from "chalk";
import type { ActionTracker } from "./action-tracker.ts";
import type { ActionLog } from "./types.ts";
import {
    applySelectedHunks,
    colorizePatch,
    composeBeforeAfter,
    fileHunks,
    formatPatch,
    hunkText,
} from "./diff-view.ts";

export interface ReviewGroup {
    label: string;
    kind: "file" | "folder" | "shell";
    path: string;
    actionIds: string[];
    patch: string | null;
    before: string;
    after: string;
    /** True when the change is a plain edit (not a create/delete), so hunks can be picked. */
    editable: boolean;
}

export function groupPending(pending: ActionLog[]): ReviewGroup[] {
    const byPath = new Map<string, ActionLog[]>();
    const shells: ActionLog[] = [];

    for (const a of pending) {
        if (a.type === "tool_execute") {
            shells.push(a);
            continue;
        }
        const key = a.path;
        if (!byPath.has(key)) byPath.set(key, []);
        byPath.get(key)!.push(a);
    }

    const groups: ReviewGroup[] = [];

    const pathEntries = [...byPath.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
    );
    for (const [p, acts] of pathEntries) {
        const sorted = acts.sort(
            (x, y) => x.timestamp.getTime() - y.timestamp.getTime(),
        );
        const ids = sorted.map((x) => x.id);

        if (sorted.every((x) => x.type === "folder_create")) {
            groups.push({
                label: `Create folder: ${p}`,
                kind: "folder",
                path: p,
                actionIds: ids,
                patch: null,
                before: "",
                after: "",
                editable: false,
            });
            continue;
        }

        const { before, after } = composeBeforeAfter(sorted);
        const patch = formatPatch(p, before, after);
        const kinds = [...new Set(sorted.map((x) => x.type))].join(", ");
        const editable =
            sorted[0]!.type !== "file_create" && sorted[sorted.length - 1]!.type !== "file_delete";
        groups.push({ label: `${p} (${kinds})`, kind: "file", path: p, actionIds: ids, patch, before, after, editable });
    }

    for (const s of shells) {
        groups.push({
            label: `Shell: ${s.details.command ?? "(no command)"}`,
            kind: "shell",
            path: "shell",
            actionIds: [s.id],
            patch: null,
            before: "",
            after: "",
            editable: false,
        });
    }

    return groups;
}

function setGroup(tracker: ActionTracker, g: ReviewGroup, accept: boolean) {
    for (const id of g.actionIds)
        tracker.updateStatus(id, accept ? "approved" : "rejected", accept);
}

/**
 * Walk through the hunks of one file and keep only the ones the user accepts.
 * Returns false if the user cancelled.
 */
async function pickHunks(tracker: ActionTracker, g: ReviewGroup): Promise<boolean> {
    const hunks = fileHunks(g.path, g.before, g.after);
    const keep: boolean[] = [];
    for (const [i, h] of hunks.entries()) {
        console.log(`\n${chalk.bold(`${g.path} — hunk ${i + 1}/${hunks.length}`)}\n${colorizePatch(hunkText(h))}\n`);
        const choice = await select({
            message: `Keep hunk ${i + 1}/${hunks.length}?`,
            options: [
                { value: "keep", label: "Keep" },
                { value: "skip", label: "Skip" },
                { value: "keep-rest", label: "Keep this and all remaining" },
                { value: "skip-rest", label: "Skip this and all remaining" },
            ],
        });
        if (isCancel(choice)) return false;
        if (choice === "keep-rest" || choice === "skip-rest") {
            const v = choice === "keep-rest";
            while (keep.length < hunks.length) keep.push(v);
            break;
        }
        keep.push(choice === "keep");
    }

    const kept = keep.filter(Boolean).length;
    if (kept === 0) {
        setGroup(tracker, g, false);
        console.log(chalk.dim(`  ✗ ${g.path}: all hunks skipped`));
        return true;
    }
    const merged = applySelectedHunks(g.path, g.before, g.after, keep);
    setGroup(tracker, g, true);
    // The last action's "after" is what gets written for this path.
    tracker.updateDetails(g.actionIds[g.actionIds.length - 1]!, { after: merged });
    console.log(chalk.green(`  ✓ ${g.path}: kept ${kept}/${hunks.length} hunk(s)`));
    return true;
}

function showDiff(g: ReviewGroup) {
    if (g.patch) console.log("\n" + colorizePatch(g.patch) + "\n");
    else console.log(chalk.dim("\n  (No diff available for this change)\n"));
}

export async function runApprovalFlow(
    tracker: ActionTracker,
): Promise<boolean> {
    const pending = tracker.getPendingMutations();

    if (pending.length === 0) {
        console.log(
            chalk.dim("\nNo staged file, folder, or shell changes to review.\n"),
        );
        return false;
    }

    const groups = groupPending(pending);

    while (true) {
        const choice = await select({
            message: "Apply staged changes?",
            options: [
                { value: "all", label: "Approve and apply all" },
                { value: "select", label: "Review one by one", hint: "accept / reject files, or pick individual hunks" },
                { value: "diff", label: "Show all diffs" },
                { value: "cancel", label: "Reject all" },
            ],
        });

        if (isCancel(choice) || choice === "cancel") {
            for (const a of pending) tracker.updateStatus(a.id, "rejected", false);
            return false;
        }

        if (choice === "diff") {
            for (const g of groups) {
                console.log(chalk.bold(`\n━━ ${g.label}`));
                showDiff(g);
            }
            continue;
        }

        if (choice === "all") {
            for (const a of pending) tracker.updateStatus(a.id, "approved", true);
            return true;
        }
        break;
    }

    for (const g of groups) {
        const hunkCount = g.editable ? fileHunks(g.path, g.before, g.after).length : 0;
        while (true) {
            const opt = await select({
                message: chalk.bold(g.label),
                options: [
                    { value: "accept", label: "Accept" },
                    { value: "diff", label: "Show diff", hint: g.patch ? undefined : "N/A" },
                    ...(hunkCount > 1
                        ? [{ value: "hunks", label: `Pick hunks (${hunkCount})`, hint: "keep only some changes" }]
                        : []),
                    { value: "reject", label: "Reject" },
                ],
            });

            if (isCancel(opt)) {
                for (const a of pending) tracker.updateStatus(a.id, "rejected", false);
                return false;
            }

            if (opt === "diff") {
                showDiff(g);
                continue;
            }

            if (opt === "hunks") {
                if (!(await pickHunks(tracker, g))) {
                    for (const a of pending) tracker.updateStatus(a.id, "rejected", false);
                    return false;
                }
                break;
            }

            setGroup(tracker, g, opt === "accept");
            break;
        }
    }

    return tracker.getActions().some((a) => a.status === "approved");
}
