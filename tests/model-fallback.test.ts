import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { isRateLimitError, parseModelSpec, withFallback } from "../ai/ai.config";
import { UsageTracker } from "../core/usage";

const okResult = (text: string) =>
    ({
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 3, text: 3, reasoning: 0 },
        },
        warnings: [],
    }) as any;

const rateLimited = () => Object.assign(new Error("Too Many Requests"), { statusCode: 429 });

describe("parseModelSpec", () => {
    test("explicit provider prefixes", () => {
        expect(parseModelSpec("gemini:gemini-3.5-flash")).toEqual({ provider: "gemini", modelId: "gemini-3.5-flash" });
        expect(parseModelSpec("openrouter:meta-llama/llama-3.3-70b-instruct:free")).toEqual({
            provider: "openrouter",
            modelId: "meta-llama/llama-3.3-70b-instruct:free",
        });
    });
    test("bare ids: slash means OpenRouter", () => {
        expect(parseModelSpec("openai/gpt-x").provider).toBe("openrouter");
        expect(parseModelSpec("gemini-2.5-pro").provider).toBe("gemini");
    });
});

describe("isRateLimitError", () => {
    test("detects 429 / quota / overload", () => {
        expect(isRateLimitError({ statusCode: 429 })).toBe(true);
        expect(isRateLimitError(new Error("RESOURCE_EXHAUSTED: quota"))).toBe(true);
        expect(isRateLimitError({ statusCode: 400, message: "bad request" })).toBe(false);
    });
});

describe("withFallback", () => {
    test("moves to the next model on 429 and skips the limited model afterwards", async () => {
        let primaryCalls = 0;
        const primary = new MockLanguageModelV4({
            doGenerate: async () => {
                primaryCalls++;
                throw rateLimited();
            },
        });
        const backup = new MockLanguageModelV4({ doGenerate: async () => okResult("from backup") });
        const switches: string[] = [];
        const model = withFallback(
            [
                { spec: "gemini:a", model: primary as any },
                { spec: "openrouter:b", model: backup as any },
            ],
            (from, to) => switches.push(`${from}->${to}`),
        );

        const r1 = await generateText({ model, prompt: "hi", maxRetries: 0 });
        const r2 = await generateText({ model, prompt: "hi", maxRetries: 0 });
        expect(r1.text).toBe("from backup");
        expect(r2.text).toBe("from backup");
        expect(primaryCalls).toBe(1); // cooled down on the 2nd call
        expect(switches).toEqual(["gemini:a->openrouter:b"]);
    });

    test("non rate-limit errors are not swallowed", async () => {
        const primary = new MockLanguageModelV4({
            doGenerate: async () => {
                throw Object.assign(new Error("bad request"), { statusCode: 400 });
            },
        });
        const backup = new MockLanguageModelV4({ doGenerate: async () => okResult("nope") });
        const model = withFallback([
            { spec: "gemini:a", model: primary as any },
            { spec: "gemini:b", model: backup as any },
        ], () => { });
        await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow("bad request");
    });
});

describe("UsageTracker", () => {
    test("tracks per-turn and total usage with optional pricing", () => {
        const u = new UsageTracker();
        u.startTurn();
        u.addStep({ inputTokens: 1000, outputTokens: 100 }, "gemini-3.5-flash-lite");
        u.addStep({ inputTokens: 2000, outputTokens: 50 }, "gemini-3.5-flash-lite");
        expect(u.turnDelta()).toMatchObject({ input: 3000, output: 150, calls: 2 });
        expect(u.lastInputTokens).toBe(2000);
        expect(u.cost({})).toBeNull();
        expect(u.cost({ "gemini-3.5-flash-lite": { input: 1, output: 2 } })).toBeCloseTo(0.0033, 6);
        const restored = UsageTracker.fromJSON(JSON.parse(JSON.stringify(u.toJSON())));
        expect(restored.total.input).toBe(3000);
    });
});
