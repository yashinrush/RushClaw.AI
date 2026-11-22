import { describe, expect, test } from "bun:test";
import { applySelectedHunks, changeStats, fileHunks } from "../modes/agent/diff-view";

const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const after = before.replace("line 2\n", "line TWO\n").replace("line 25\n", "line TWENTY-FIVE\n");

describe("hunk selection", () => {
    test("two distant edits produce two hunks", () => {
        expect(fileHunks("f.txt", before, after)).toHaveLength(2);
    });

    test("keep only the first hunk", () => {
        const out = applySelectedHunks("f.txt", before, after, [true, false]);
        expect(out).toContain("line TWO");
        expect(out).toContain("line 25\n");
        expect(out).not.toContain("TWENTY-FIVE");
    });

    test("keep only the second hunk", () => {
        const out = applySelectedHunks("f.txt", before, after, [false, true]);
        expect(out).toContain("line 2\n");
        expect(out).toContain("TWENTY-FIVE");
    });

    test("all / none", () => {
        expect(applySelectedHunks("f.txt", before, after, [true, true])).toBe(after);
        expect(applySelectedHunks("f.txt", before, after, [false, false])).toBe(before);
    });

    test("hunks that change line counts still apply", () => {
        const grown = before.replace("line 3\n", "line 3\nextra a\nextra b\n").replace("line 28\n", "");
        const out = applySelectedHunks("f.txt", before, grown, [false, true]);
        expect(out).not.toContain("extra a");
        expect(out).not.toContain("line 28\n");
    });
});

describe("changeStats", () => {
    test("counts added and removed lines", () => {
        expect(changeStats("a\nb\n", "a\nc\nd\n")).toEqual({ added: 2, removed: 1 });
    });
});
