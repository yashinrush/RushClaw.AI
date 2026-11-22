import { createTwoFilesPatch, diffLines } from "diff";
import type { ActionLog } from "./types";

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