import { marked } from "marked";
import { markedTerminal } from "marked-terminal";

let ready = false;

function ensureMarked(): void {
    if (ready) return;
    // replies are indented by 2 columns in the chat, so leave room for that
    const w = Math.max(40, Math.min((process.stdout.columns || 80) - 4, 116));
    //   @ts-ignore
    marked.use(markedTerminal({ width: w, reflowText: true }, {}));
    ready = true;
}

export function renderTerminalMarkdown(source: string): string {
    ensureMarked();
    return marked.parse(source.trimEnd(), { async: false }) as string;
}