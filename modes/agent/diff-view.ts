import chalk from "chalk";
import { applyPatch, createTwoFilesPatch, diffLines, structuredPatch, type StructuredPatch } from "diff";
import type { ActionLog } from "./types";

export type Hunk = StructuredPatch["hunks"][number];

/** The individual change blocks ("hunks") between two versions of a file. */
export function fileHunks(filePath: string, before: string, after: string): Hunk[] {
    return structuredPatch(filePath, filePath, before, after, "", "", { context: 3 }).hunks;
}

export function hunkText(h: Hunk): string {
    return [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join("\n");
}

/**
 * Apply only the hunks the user kept. Hunks never overlap, so applying a subset
 * of them to the original always succeeds.
 */
export function applySelectedHunks(filePath: string, before: string, after: string, keep: boolean[]): string {
    const patch = structuredPatch(filePath, filePath, before, after, "", "", { context: 3 });
    const selected: StructuredPatch = { ...patch, hunks: patch.hunks.filter((_, i) => keep[i]) };
    if (selected.hunks.length === 0) return before;
    if (selected.hunks.length === patch.hunks.length) return after;
    const result = applyPatch(before, selected);
    if (result === false) throw new Error(`Could not apply the selected hunks to ${filePath}`);
    return result;
}

/** Color a unified diff for the terminal. */
export function colorizePatch(patch: string): string {
    return patch
        .split("\n")
        .map((l) => {
            if (l.startsWith("+++") || l.startsWith("---")) return chalk.bold(l);
            if (l.startsWith("@@")) return chalk.cyan(l);
            if (l.startsWith("+")) return chalk.green(l);
            if (l.startsWith("-")) return chalk.red(l);
            if (l.startsWith("=====")) return chalk.dim(l);
            return chalk.dim(l);
        })
        .join("\n");
}

export function formatPatch(
    filePath: string,
    before: string,
    after: string,
): string {
    return createTwoFilesPatch(filePath, filePath, before, after, "", "", {
        context: 3,
    });
}

/** Added / removed line counts between two versions of a file. */
export function changeStats(before: string, after: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const part of diffLines(before, after)) {
        const n = part.count ?? part.value.split("\n").length - 1;
        if (part.added) added += n;
        else if (part.removed) removed += n;
    }
    return { added, removed };
}

export function composeBeforeAfter(sorted: ActionLog[]): {
    before: string;
    after: string;
} {
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    if (last.type === "file_delete")
        return { before: last.details.before ?? "", after: "" };
    const before =
        first.type === "file_create" ? "" : (first.details.before ?? "");
    const after = last.details.after ?? "";
    return { before, after };
}