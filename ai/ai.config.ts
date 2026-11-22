import chalk from "chalk";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { wrapLanguageModel } from "ai";
import { loadConfig } from "../core/config";

export type ProviderName = "gemini" | "openrouter";

export interface ModelSpec {
    provider: ProviderName;
    modelId: string;
}

/** The provider-level model object both SDK providers return (LanguageModelV4). */
type BaseModel = Parameters<typeof wrapLanguageModel>[0]["model"];

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_OPENROUTER_MODEL = "openrouter/auto";
/** How long a rate-limited model is skipped before it is tried again. */
const COOLDOWN_MS = 60_000;

function geminiKey(): string | undefined {
    return process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || undefined;
}

function openrouterKey(): string | undefined {
    return process.env.OPENROUTER_API_KEY?.trim() || undefined;
}

export function hasProviderKey(provider: ProviderName): boolean {
    return provider === "gemini" ? !!geminiKey() : !!openrouterKey();
}

/**
 * "gemini:gemini-3.5-flash" / "openrouter:meta-llama/llama-3.3-70b-instruct:free".
 * Without a prefix, ids containing "/" are treated as OpenRouter, others as Gemini.
 */
export function parseModelSpec(spec: string): ModelSpec {
    const s = spec.trim();
    const m = s.match(/^(gemini|google|openrouter):(.+)$/i);
    if (m) {
        return {
            provider: m[1]!.toLowerCase() === "openrouter" ? "openrouter" : "gemini",
            modelId: m[2]!.trim(),
        };
    }
    return { provider: s.includes("/") ? "openrouter" : "gemini", modelId: s };
}

export function formatModelSpec(spec: ModelSpec | string): string {
    const s = typeof spec === "string" ? parseModelSpec(spec) : spec;
    return `${s.provider}:${s.modelId}`;
}

/** Model from config, else from env (Gemini preferred when its key is set). */
export function defaultModelSpec(configModel?: string): string {
    if (configModel?.trim()) return formatModelSpec(configModel);
    if (geminiKey()) {
        const id =
            process.env.GEMINI_MODEL?.trim() ||
            process.env.GOOGLE_DEFAULT_MODEL?.trim() ||
            DEFAULT_GEMINI_MODEL;
        return `gemini:${id}`;
    }
    return `openrouter:${process.env.OPENROUTER_DEFAULT_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL}`;
}

export function createBaseModel(spec: string): BaseModel {
    const { provider, modelId } = parseModelSpec(spec);
    if (provider === "gemini") {
        const google = createGoogleGenerativeAI({ apiKey: geminiKey() });
        return google(modelId);
    }
    const openrouter = createOpenRouter({ apiKey: openrouterKey() });
    return openrouter(modelId) as BaseModel;
}

/** 429s, quota exhaustion and overload errors — worth retrying on another model. */
export function isRateLimitError(err: unknown): boolean {
    const e = err as { statusCode?: number; status?: number; message?: string } | undefined;
    const code = e?.statusCode ?? e?.status;
    if (code === 429 || code === 503 || code === 529) return true;
    const msg = String(e?.message ?? err ?? "");
    return /rate limit|429|quota|RESOURCE_EXHAUSTED|overloaded|too many requests/i.test(msg);
}

export interface ModelOptions {
    /** Specs to try, in order, when the primary model is rate limited. */
    fallbacks?: string[];
    /** Called when a request moves to a fallback model. */
    onFallback?: (from: string, to: string, err: unknown) => void;
}

function defaultOnFallback(from: string, to: string) {
    console.log(chalk.yellow(`\n⚠️  ${from} is rate limited — falling back to ${to}`));
}

/**
 * Build the model used by every mode. With fallbacks, a rate-limited request is
 * transparently retried on the next model, and the limited model is skipped for
 * a minute so later steps don't hit the same 429 again.
 */
export function getAgentModel(spec?: string, opts: ModelOptions = {}) {
    const cfg = spec === undefined || opts.fallbacks === undefined ? loadConfig() : null;
    const primarySpec = formatModelSpec(spec ?? defaultModelSpec(cfg?.model));
    const fallbackSpecs = (opts.fallbacks ?? cfg?.fallbackModels ?? [])
        .map(formatModelSpec)
        .filter((s) => s !== primarySpec && hasProviderKey(parseModelSpec(s).provider));

    const primary = createBaseModel(primarySpec);
    if (fallbackSpecs.length === 0) return primary;

    return withFallback(
        [
            { spec: primarySpec, model: primary },
            ...fallbackSpecs.map((s) => ({ spec: s, model: createBaseModel(s) })),
        ],
        opts.onFallback ?? defaultOnFallback,
    );
}

/** Wrap the first model so rate-limit errors move the call down the chain. */
export function withFallback(
    chain: Array<{ spec: string; model: BaseModel }>,
    onFallback: NonNullable<ModelOptions["onFallback"]> = defaultOnFallback,
) {
    // Both providers return v4 models at runtime; the declared union also covers
    // older spec versions, so call through a narrow structural type.
    type CallableModel = {
        doGenerate(params: unknown): PromiseLike<any>;
        doStream(params: unknown): PromiseLike<any>;
    };
    const specs = chain.map((c) => c.spec);
    const models = chain.map((c) => c.model) as unknown as CallableModel[];
    const primary = chain[0]!.model;
    const cooldownUntil = new Map<number, number>();

    async function runChain<T>(call: (i: number) => PromiseLike<T>): Promise<T> {
        let lastErr: unknown;
        let previous: number | null = null;
        for (let i = 0; i < models.length; i++) {
            if ((cooldownUntil.get(i) ?? 0) > Date.now() && i < models.length - 1) continue;
            if (previous !== null) onFallback(specs[previous]!, specs[i]!, lastErr);
            try {
                const r = await call(i);
                cooldownUntil.delete(i);
                return r;
            } catch (err) {
                if (!isRateLimitError(err)) throw err;
                cooldownUntil.set(i, Date.now() + COOLDOWN_MS);
                lastErr = err;
                previous = i;
            }
        }
        throw lastErr;
    }

    return wrapLanguageModel({
        model: primary,
        middleware: {
            specificationVersion: "v4",
            wrapGenerate: ({ doGenerate, params }) =>
                runChain((i) => (i === 0 ? doGenerate() : models[i]!.doGenerate(params))),
            wrapStream: ({ doStream, params }) =>
                runChain((i) => (i === 0 ? doStream() : models[i]!.doStream(params))),
        },
    });
}
