import { describe, expect, test } from "bun:test";
import path from "node:path";
import "./helpers"; // isolates RUSHCLAW_HOME

const ROOT = path.join(import.meta.dir, "..");

async function cli(args: string[]) {
    const proc = Bun.spawn(["bun", path.join(ROOT, "index.ts"), ...args], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
        // no API keys: we only check argument parsing / error handling here
        env: { ...process.env, GEMINI_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "", OPENROUTER_API_KEY: "", RUSHCLAW_NO_EXTRA_ENV: "1" },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, stdout, stderr };
}

describe("CLI", () => {
    test("--help lists headless options and subcommands", async () => {
        const r = await cli(["--help"]);
        expect(r.stdout).toContain("--print <prompt>");
        expect(r.stdout).toContain("chat [options] [prompt...]");
        expect(r.stdout).toContain("undo");
        expect(r.stdout).toContain("sessions");
    });

    test("subcommand options don't collide with root options", async () => {
        const r = await cli(["chat", "--help"]);
        expect(r.stdout).toContain("--resume [sessionId]");
        expect(r.stdout).toContain("--auto-edit");
    });

    test("headless JSON output reports provider errors with exit code 1", async () => {
        const r = await cli(["-p", "hello", "--output", "json", "--model", "gemini:gemini-3.5-flash-lite"]);
        expect(r.code).toBe(1);
        const out = JSON.parse(r.stdout);
        expect(out.error).toContain("No API key configured for gemini");
        expect(out.staged).toEqual([]);
        expect(typeof out.sessionId).toBe("string");
    }, 60_000);
});

describe(".env loading", () => {
    test("parseEnv handles quotes, comments and export", async () => {
        const { parseEnv } = await import("../core/env");
        expect(parseEnv(`# c\nA=1\nexport B="two words"\nC='x' \nD=val # note\n`)).toEqual({ A: "1", B: "two words", C: "x", D: "val" });
    });
});
