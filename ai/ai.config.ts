import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

export function getAgentModel() {
    const geminiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
    if (geminiKey) {
        const google = createGoogleGenerativeAI({ apiKey: geminiKey });
        const modelId = process.env.GEMINI_MODEL?.trim() || process.env.GOOGLE_DEFAULT_MODEL?.trim() || "gemini-3.5-flash-lite";
        return google(modelId);
    }

    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const provider = createOpenRouter({ apiKey });

    const modelId = process.env.OPENROUTER_DEFAULT_MODEL?.trim() || "openrouter/auto";

    return provider(modelId);
}