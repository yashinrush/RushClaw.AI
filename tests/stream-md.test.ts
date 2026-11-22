import { describe, expect, test } from "bun:test";
import { StreamingMarkdown } from "../tui/stream-md";

function collect() {
    const out: string[] = [];
    const md = new StreamingMarkdown((s) => out.push(s), (m) => `<${m.trim()}>`);
    return { md, out };
}

describe("StreamingMarkdown", () => {
    test("flushes completed paragraphs while streaming", () => {
        const { md, out } = collect();
        md.push("First para");
        expect(out).toHaveLength(0);
        md.push("graph.\n\nSecond");
        expect(out).toEqual(["<First paragraph.>\n"]);
        md.flush();
        expect(out[1]).toBe("<Second>\n");
    });

    test("never splits inside a code fence", () => {
        const { md, out } = collect();
        md.push("```ts\nconst a = 1;\n\nconst b = 2;\n");
        expect(out).toHaveLength(0); // blank line inside the fence is not a boundary
        md.push("```\nafter");
        expect(out).toHaveLength(1);
        expect(out[0]).toContain("const b = 2;");
        expect(out[0]).toContain("```");
        md.flush();
        expect(out[1]).toBe("<after>\n");
    });

    test("long paragraphs are flushed at a newline", () => {
        const out: string[] = [];
        const md = new StreamingMarkdown((s) => out.push(s), (m) => m, 50);
        md.push("x".repeat(40) + "\n" + "y".repeat(40));
        expect(out).toHaveLength(1);
        expect(md.pending).toBe("y".repeat(40));
    });
});
