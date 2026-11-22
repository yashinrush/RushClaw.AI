import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { defaultBranch, diffForFiles, generateCommitMessage, generatePrDescription, git, statusEntries } from "../core/git";
import { tempWorkspace } from "./helpers";

function repo() {
    const root = tempWorkspace({ "a.txt": "one\n" });
    git(["init", "-q", "-b", "main"], root);
    git(["config", "user.email", "test@example.com"], root);
    git(["config", "user.name", "Test"], root);
    git(["add", "."], root);
    git(["commit", "-q", "-m", "init"], root);
    return root;
}

const textModel = (text: string) =>
    new MockLanguageModelV4({
        doGenerate: async () =>
            ({
                content: [{ type: "text", text }],
                finishReason: { unified: "stop", raw: "stop" },
                usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
                warnings: [],
            }) as any,
    });

describe("git helpers", () => {
    test("status and diff include tracked and untracked files", () => {
        const root = repo();
        fs.writeFileSync(path.join(root, "a.txt"), "one\ntwo\n");
        fs.writeFileSync(path.join(root, "b.txt"), "brand new\n");
        const entries = statusEntries(root);
        expect(entries.map((e) => [e.path, e.untracked])).toEqual([
            ["a.txt", false],
            ["b.txt", true],
        ]);
        const d = diffForFiles(root, entries);
        expect(d).toContain("+two");
        expect(d).toContain("new file b.txt");
        expect(d).toContain("+brand new");
        expect(defaultBranch(root)).toBe("main");
    });

    test("commit message generation strips code fences", async () => {
        const r = await generateCommitMessage(textModel("```\nfix: handle empty input\n```") as any, "diff", "");
        expect(r.text).toBe("fix: handle empty input");
    });

    test("PR description is parsed into title and body", async () => {
        const r = await generatePrDescription(
            textModel("TITLE: Add hooks support\nBODY:\n## Summary\n- hooks") as any,
            "abc feat",
            "",
            "",
        );
        expect(r.title).toBe("Add hooks support");
        expect(r.body).toStartWith("## Summary");
    });
});
