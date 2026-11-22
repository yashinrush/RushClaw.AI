import chalk from "chalk";
import { defaultModelSpec, hasProviderKey, isRateLimitError, parseModelSpec } from "../ai/ai.config";
import { loadConfig } from "./config";

/**
 * Turn a provider error into a message that matches the provider actually in use
 * (the old code always blamed OpenRouter's free tier, even on Gemini).
 */
export function describeError(err: unknown, activeSpec?: string): { title: string; tips: string[] } {
    const spec = activeSpec ?? defaultModelSpec(loadConfig().model);
    const { provider, modelId } = parseModelSpec(spec);
    const e = err as { statusCode?: number; message?: string } | undefined;
    const msg = String(e?.message ?? err ?? "Unknown error");
    const code = e?.statusCode;

    if (!hasProviderKey(provider)) {
        return {
            title: `No API key configured for ${provider}.`,
            tips: [
                provider === "gemini"
                    ? "Set GEMINI_API_KEY in .env (free key: https://aistudio.google.com/)"
                    : "Set OPENROUTER_API_KEY in .env (https://openrouter.ai/keys)",
                "Or switch provider with /model (e.g. /model gemini:gemini-3.5-flash-lite).",
            ],
        };
    }

    if (isRateLimitError(err)) {
        if (provider === "gemini") {
            return {
                title: `Rate limit / quota reached on Gemini (${modelId}).`,
                tips: [
                    "Google AI Studio free tier has per-minute and per-day limits — wait a minute and retry.",
                    "Switch to a model with higher limits: /model gemini:gemini-3.5-flash-lite",
                    'Add automatic fallbacks in rushclaw.config.json: "fallbackModels": ["openrouter:openrouter/auto"]',
                ],
            };
        }
        return {
            title: `Rate limit reached on OpenRouter (${modelId}).`,
            tips: [
                "Free OpenRouter models are limited to ~50 requests/day without credits (1000/day with credits).",
                "Switch model: /model openrouter:meta-llama/llama-3.3-70b-instruct:free (or a Gemini model)",
                'Add automatic fallbacks in rushclaw.config.json: "fallbackModels": ["gemini:gemini-3.5-flash-lite"]',
            ],
        };
    }

    if (code === 401 || code === 403 || /api key|unauthori[sz]ed|permission denied/i.test(msg)) {
        return {
            title: `Authentication failed for ${provider}: ${msg}`,
            tips: [`Check the ${provider === "gemini" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY"} value in .env.`],
        };
    }

    if (code === 404 || /not found|unknown model|invalid model/i.test(msg)) {
        return {
            title: `Model "${modelId}" was not found on ${provider}: ${msg}`,
            tips: ["Pick another model with /model, or fix GEMINI_MODEL / OPENROUTER_DEFAULT_MODEL in .env."],
        };
    }

    return { title: msg, tips: [] };
}

export function printError(err: unknown, activeSpec?: string, prefix = "Error"): void {
    const { title, tips } = describeError(err, activeSpec);
    console.log(chalk.red(`\n❌ ${prefix}: ${title}`));
    if (tips.length) {
        console.log(chalk.yellow("👉 Suggestions:"));
        tips.forEach((t, i) => console.log(chalk.dim(`   ${i + 1}. ${t}`)));
    }
    console.log();
}

/** Plain-text version for Telegram / JSON output. */
export function errorText(err: unknown, activeSpec?: string): string {
    const { title, tips } = describeError(err, activeSpec);
    return [title, ...tips.map((t) => `• ${t}`)].join("\n");
}
