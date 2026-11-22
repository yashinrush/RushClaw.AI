import fs from "node:fs";
import path from "node:path";
import type { UserContent } from "./engine";

export const IMAGE_TYPES: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImageRef {
    path: string;
    name: string;
    mediaType: string;
    /** base64 — serializable, so sessions can be saved and resumed. */
    data: string;
    bytes: number;
}

export interface ExtractResult {
    text: string;
    images: ImageRef[];
    /** @-references that couldn't be loaded, with the reason. */
    problems: string[];
}

// @path, "quoted path", 'quoted path' or a bare path ending in an image extension
const IMAGE_TOKEN =
    /(^|\s)(@?"[^"\n]+\.(?:png|jpe?g|gif|webp)"|@?'[^'\n]+\.(?:png|jpe?g|gif|webp)'|@?[^\s"']+\.(?:png|jpe?g|gif|webp))(?=\s|$|[,.;:!?])/gi;

/**
 * Find image references in the user's message and load them. Explicit
 * @references that fail are reported; bare file names that don't exist are left
 * alone (the user may just be talking about a file).
 */
export function extractImageRefs(input: string, root: string): ExtractResult {
    const images: ImageRef[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();

    const text = input.replace(IMAGE_TOKEN, (match, lead: string, token: string) => {
        const explicit = token.startsWith("@");
        const raw = token.replace(/^@/, "").replace(/^["']|["']$/g, "");
        const abs = path.resolve(root, raw);
        const name = path.basename(abs);
        let st: fs.Stats | null = null;
        try {
            st = fs.statSync(abs);
        } catch { }

        if (!st || !st.isFile()) {
            if (explicit) problems.push(`${raw}: file not found`);
            return match;
        }
        if (st.size > MAX_IMAGE_BYTES) {
            problems.push(`${raw}: larger than 10 MB`);
            return match;
        }
        if (!seen.has(abs)) {
            seen.add(abs);
            images.push({
                path: abs,
                name,
                mediaType: IMAGE_TYPES[path.extname(abs).toLowerCase()] ?? "image/png",
                data: fs.readFileSync(abs).toString("base64"),
                bytes: st.size,
            });
        }
        return `${lead}[image: ${name}]`;
    });

    return { text, images, problems };
}

/** Model message content: plain text, or text + image parts. */
export function buildUserContent(text: string, images: ImageRef[]): string | UserContent {
    if (!images.length) return text;
    return [
        { type: "text", text },
        // AI SDK 7: images are "file" parts with an image/* media type.
        ...images.map((img) => ({ type: "file" as const, data: img.data, mediaType: img.mediaType, filename: img.name })),
    ];
}
