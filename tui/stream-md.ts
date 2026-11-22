import { renderTerminalMarkdown } from "./terminal-md";

const FENCE = /^\s*(```|~~~)/;

/**
 * Renders streamed Markdown block by block: text is flushed (and pretty-printed)
 * at blank lines outside code fences, so output appears while the model is still
 * writing without breaking lists or code blocks.
 */
export class StreamingMarkdown {
    private buf = "";
    private inFence = false;

    constructor(
        private readonly write: (s: string) => void = (s) => process.stdout.write(s),
        private readonly render: (md: string) => string = renderTerminalMarkdown,
        /** Flush a long paragraph at its last newline once it grows past this size. */
        private readonly softLimit = 1500,
    ) { }

    push(delta: string): void {
        this.buf += delta;
        this.flushComplete();
    }

    /** Emit whatever is buffered (end of a text block). */
    flush(): void {
        if (this.buf.trim()) this.emit(this.buf);
        this.buf = "";
        this.inFence = false;
    }

    get pending(): string {
        return this.buf;
    }

    private flushComplete(): void {
        const lines = this.buf.split("\n");
        let fenceOpen = this.inFence;
        let consumed = 0;
        let safeEnd = -1;
        let lastNewlineOutsideFence = -1;
        let safeFence = this.inFence;

        // The last element is an unfinished line — never split inside it.
        for (let i = 0; i < lines.length - 1; i++) {
            const line = lines[i]!;
            consumed += line.length + 1;
            const isFence = FENCE.test(line);
            if (isFence) fenceOpen = !fenceOpen;
            if (!fenceOpen && (line.trim() === "" || isFence)) {
                safeEnd = consumed;
                safeFence = fenceOpen;
            }
            if (!fenceOpen) lastNewlineOutsideFence = consumed;
        }

        if (safeEnd <= 0 && this.buf.length > this.softLimit && lastNewlineOutsideFence > 0) {
            safeEnd = lastNewlineOutsideFence;
            safeFence = false;
        }
        if (safeEnd > 0) {
            const chunk = this.buf.slice(0, safeEnd);
            this.buf = this.buf.slice(safeEnd);
            this.inFence = safeFence;
            this.emit(chunk);
        }
    }

    private emit(chunk: string): void {
        if (!chunk.trim()) return;
        const out = this.render(chunk);
        this.write(out.endsWith("\n") ? out : out + "\n");
    }
}
