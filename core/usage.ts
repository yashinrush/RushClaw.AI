import type { ModelPrice } from "./config";

/** Shape of the AI SDK's LanguageModelUsage that we rely on. */
export interface UsageLike {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
}

export interface TokenCounts {
    input: number;
    output: number;
    cachedInput: number;
    calls: number;
}

const zero = (): TokenCounts => ({ input: 0, output: 0, cachedInput: 0, calls: 0 });

export function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

function priceFor(modelId: string, pricing: Record<string, ModelPrice>): ModelPrice | undefined {
    if (pricing[modelId]) return pricing[modelId];
    const bare = modelId.replace(/^models\//, "").replace(/^(gemini|openrouter):/, "");
    if (pricing[bare]) return pricing[bare];
    const hit = Object.keys(pricing).find((k) => bare.endsWith(k) || k.endsWith(bare));
    return hit ? pricing[hit] : undefined;
}

/** Token (and optional cost) accounting for a session, per model. */
export class UsageTracker {
    total: TokenCounts = zero();
    byModel = new Map<string, TokenCounts>();
    /** Input tokens of the most recent model call ≈ current context size. */
    lastInputTokens = 0;
    private turnStart: TokenCounts = zero();

    addStep(usage: UsageLike | undefined, modelId = "unknown"): void {
        if (!usage) return;
        const input = usage.inputTokens ?? 0;
        const output = usage.outputTokens ?? 0;
        const cached = usage.inputTokenDetails?.cacheReadTokens ?? 0;
        for (const t of [this.total, this.model(modelId)]) {
            t.input += input;
            t.output += output;
            t.cachedInput += cached;
            t.calls += 1;
        }
        if (input) this.lastInputTokens = input;
    }

    private model(id: string): TokenCounts {
        let t = this.byModel.get(id);
        if (!t) {
            t = zero();
            this.byModel.set(id, t);
        }
        return t;
    }

    startTurn(): void {
        this.turnStart = { ...this.total };
    }

    turnDelta(): TokenCounts {
        return {
            input: this.total.input - this.turnStart.input,
            output: this.total.output - this.turnStart.output,
            cachedInput: this.total.cachedInput - this.turnStart.cachedInput,
            calls: this.total.calls - this.turnStart.calls,
        };
    }

    /** Estimated USD cost, or null when no pricing is configured for any model used. */
    cost(pricing: Record<string, ModelPrice>): number | null {
        let sum = 0;
        let known = false;
        for (const [id, t] of this.byModel) {
            const p = priceFor(id, pricing);
            if (!p) continue;
            known = true;
            sum += (t.input / 1e6) * p.input + (t.output / 1e6) * p.output;
        }
        return known ? sum : null;
    }

    formatTurn(): string {
        const d = this.turnDelta();
        return `${fmtTokens(d.input)} in · ${fmtTokens(d.output)} out · ${d.calls} call(s) · context ${fmtTokens(this.lastInputTokens)}`;
    }

    formatSummary(pricing: Record<string, ModelPrice>): string {
        const lines = [
            `Total: ${fmtTokens(this.total.input)} input (${fmtTokens(this.total.cachedInput)} cached) · ${fmtTokens(this.total.output)} output · ${this.total.calls} model call(s)`,
            `Current context: ~${fmtTokens(this.lastInputTokens)} tokens`,
        ];
        for (const [id, t] of this.byModel) {
            lines.push(`  ${id}: ${fmtTokens(t.input)} in · ${fmtTokens(t.output)} out · ${t.calls} call(s)`);
        }
        const c = this.cost(pricing);
        lines.push(
            c === null
                ? 'Cost: n/a — add "pricing" to rushclaw.config.json to estimate it (Gemini free tier costs $0).'
                : `Estimated cost: $${c.toFixed(4)}`,
        );
        return lines.join("\n");
    }

    toJSON() {
        return {
            total: this.total,
            byModel: Object.fromEntries(this.byModel),
            lastInputTokens: this.lastInputTokens,
        };
    }

    static fromJSON(data: ReturnType<UsageTracker["toJSON"]> | undefined): UsageTracker {
        const u = new UsageTracker();
        if (!data) return u;
        u.total = { ...zero(), ...data.total };
        for (const [k, v] of Object.entries(data.byModel ?? {})) u.byModel.set(k, { ...zero(), ...v });
        u.lastInputTokens = data.lastInputTokens ?? 0;
        return u;
    }
}
