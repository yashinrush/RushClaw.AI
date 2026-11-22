import { generateText } from "ai";
import { createBaseModel, defaultModelSpec, hasProviderKey, parseModelSpec } from "../../ai/ai.config";
import { loadConfig } from "../../core/config";

/** Pending voice transcripts waiting for the user to pick Ask / Agent / Plan. */
export const voiceTranscripts = new Map<number, string>();

export function canTranscribe(): boolean {
    return hasProviderKey("gemini");
}

/**
 * Transcribe a Telegram voice note with Gemini (audio input). Uses the
 * configured model when it is a Gemini model, otherwise Gemini Flash Lite.
 */
export async function transcribeAudio(audio: Uint8Array, mediaType: string): Promise<string> {
    const configured = defaultModelSpec(loadConfig().model);
    const spec = parseModelSpec(configured).provider === "gemini" ? configured : "gemini:gemini-3.5-flash-lite";
    const r = await generateText({
        model: createBaseModel(spec),
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: "Transcribe this voice message exactly as spoken (keep the original language). Output only the transcript, no commentary.",
                    },
                    { type: "file", data: audio, mediaType },
                ],
            },
        ],
    });
    return r.text.trim();
}
