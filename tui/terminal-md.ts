import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { wrapAnsi } from "./theme";

let ready = false;

function ensureMarked(): void {
    if (ready) return;
    // Replies are indented by 2 columns in the chat, and marked-terminal adds
    // list/quote indentation *after* reflowing, so leave room for both.
    const w = Math.max(40, Math.min((process.stdout.columns || 80) - 12, 108));
    //   @ts-ignore
    marked.use(markedTerminal({ width: w, reflowText: true, showSectionPrefix: false }, {}));

    // marked-terminal 7.x ignores the inline tokens marked 18 puts inside
    // block-level "text" tokens (tight list items), so **bold** and `code`
    // showed up raw and long items never wrapped. Render them inline here and
    // wrap to the list's width. Returning false falls back to marked-terminal.
    marked.use({
        renderer: {
            text(token: any) {
                if (typeof token !== "object" || !token.tokens?.length) return false;
                // @ts-ignore — `this` is the renderer; parser is set by marked
                const inline: string = this.parser.parseInline(token.tokens);
                // marked-terminal indents the continuation lines under the marker itself
                return wrapAnsi(inline, w - 8).join("\n");
            },
        },
    });
    ready = true;
}

export function renderTerminalMarkdown(source: string): string {
    ensureMarked();
    return marked.parse(source.trimEnd(), { async: false }) as string;
}
