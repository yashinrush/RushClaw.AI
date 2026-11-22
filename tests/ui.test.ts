import { describe, expect, test } from "bun:test";
import {
    box,
    changeBar,
    fmtDuration,
    gradient,
    gradientAt,
    progressBar,
    shimmer,
    stripAnsi,
    truncateVisible,
    visibleWidth,
    wrap,
} from "../tui/theme";
import { formatToolCall, formatToolResult, miniDiff, toolKind, toolLabel } from "../tui/tool-display";
import { bannerLines, colorBannerRow } from "../tui/wakeup";
import { decorateReply } from "../tui/chat-ui";
import { formatTodos } from "../core/todos";
import { Activity, THINKING_VERBS } from "../tui/activity";

describe("theme", () => {
    test("gradient keeps the text and interpolates colors", () => {
        expect(stripAnsi(gradient("rushclaw"))).toBe("rushclaw");
        expect(gradientAt(["#000000", "#ffffff"], 0.5)).toBe("#808080");
        expect(gradientAt(["#000000", "#ffffff"], 2)).toBe("#ffffff");
        expect(stripAnsi(shimmer("Thinking…", 3))).toBe("Thinking…");
    });

    test("visible width ignores ANSI and counts emoji as 2", () => {
        expect(visibleWidth("\x1b[31mabc\x1b[0m")).toBe(3);
        expect(visibleWidth("📎a")).toBe(3);
        expect(stripAnsi(truncateVisible("abcdefghij", 5))).toBe("abcd…");
    });

    test("box lines all have the same width", () => {
        const b = box(["short", "a much longer line of text", "\x1b[32mcolored\x1b[0m"], { title: "Title" });
        const widths = b.split("\n").map(visibleWidth);
        expect(new Set(widths).size).toBe(1);
        expect(stripAnsi(b)).toContain("Title");
    });

    test("wrap respects width", () => {
        const lines = wrap("the quick brown fox jumps over the lazy dog", 10);
        expect(lines.every((l) => l.length <= 10)).toBe(true);
        expect(lines.join(" ")).toBe("the quick brown fox jumps over the lazy dog");
    });

    test("bars and durations", () => {
        expect(stripAnsi(progressBar(3, 6, 6)).length).toBe(6);
        expect(stripAnsi(changeBar(10, 5, 15, 12))).toBe("++++++++----");
        expect(stripAnsi(changeBar(0, 0, 1))).toBe("");
        expect(fmtDuration(820)).toBe("820ms");
        expect(fmtDuration(4200)).toBe("4.2s");
        expect(fmtDuration(65_000)).toBe("1m 05s");
    });
});

describe("tool display", () => {
    test("labels and kinds", () => {
        expect(toolLabel("edit_file", { path: "a.ts" })).toBe("Edit a.ts");
        expect(toolKind("mcp__gh__x")).toBe("mcp");
        expect(toolKind("grep")).toBe("read");
        expect(stripAnsi(formatToolCall("run_command", { command: "bun test" }))).toContain("Run bun test");
    });

    test("edit results show a mini diff with counts", () => {
        const lines = formatToolResult(
            "edit_file",
            "Edited a.ts: replaced 1",
            { path: "a.ts", old_string: "a\nb", new_string: "a\nc\nd" },
            1500,
        ).map(stripAnsi);
        expect(lines[0]).toContain("Updated +2 -1");
        expect(lines[0]).toContain("1.5s");
        expect(lines.slice(1)).toEqual(["     - b", "     + c", "     + d"]);
    });

    test("miniDiff caps long diffs", () => {
        const d = miniDiff("", Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"), 5);
        expect(d.added).toBe(20);
        expect(stripAnsi(d.lines[d.lines.length - 1]!)).toContain("15 more");
    });

    test("command results show an exit badge and output tail", () => {
        const ok = formatToolResult("run_command", "$ bun test\nexit code: 0\n 2 pass\n 0 fail").map(stripAnsi);
        expect(ok[0]).toContain("exit 0");
        expect(ok).toContain("      0 fail");
        const queued = formatToolResult("run_command", '"npm i" is not on the allowlist … QUEUED').map(stripAnsi);
        expect(queued[0]).toContain("queued");
    });
});

describe("banner, replies, todos, spinner", () => {
    test("banner fits the terminal and keeps its glyphs when colored", () => {
        const wide = bannerLines(120);
        expect(wide.length).toBeGreaterThanOrEqual(5);
        const narrow = bannerLines(40);
        expect(Math.max(...narrow.map((l) => l.length)) + 4).toBeLessThanOrEqual(40);
        const row = colorBannerRow(wide[0]!, 0, wide.length, 70, { shine: 10 });
        expect(stripAnsi(row)).toBe(wide[0]!);
        expect(stripAnsi(colorBannerRow("████", 0, 1, 4, { reveal: 2 }))).toBe("██  ");
    });

    test("replies are indented with a marker on the first block", () => {
        expect(stripAnsi(decorateReply("Hello\nworld\n\n", true))).toMatch(/^. Hello\n  world\n\n$/);
        expect(stripAnsi(decorateReply("More\n", false))).toBe("  More\n\n");
    });

    test("todos show progress", () => {
        const out = stripAnsi(
            formatTodos([
                { content: "a", status: "completed" },
                { content: "b", status: "in_progress" },
            ]),
        );
        expect(out).toContain("1/2");
        expect(out).toContain("b");
    });

    test("spinner line has the label and a verb list", () => {
        const a = new Activity();
        a.set("Rushing…");
        expect(stripAnsi(a.line())).toContain("Rushing…");
        expect(THINKING_VERBS.length).toBeGreaterThan(5);
    });
});

describe("markdown lists", () => {
    test("inline formatting inside list items is rendered and long items wrap", async () => {
        const { renderTerminalMarkdown } = await import("../tui/terminal-md");
        const { wrapAnsi } = await import("../tui/theme");
        const out = stripAnsi(
            renderTerminalMarkdown(
                "1. **`subtotal`** multiplies price by qty " + "so the totals are right ".repeat(8) + "\n2. second",
            ),
        );
        expect(out).not.toContain("**");
        expect(out).not.toContain("`");
        expect(out).toContain("1. subtotal multiplies");
        expect(out.split("\n").length).toBeGreaterThan(3); // wrapped
        expect(wrapAnsi("\x1b[1mbold\x1b[22m word another", 9).map(stripAnsi)).toEqual(["bold word", "another"]);
    });
});
