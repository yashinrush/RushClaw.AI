import chalk from "chalk";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * A one-line spinner that can be stopped instantly before any other output, so
 * it never collides with streamed text or prompts (clack's spinner owns the
 * line and doesn't mix well with streaming).
 */
export class Activity {
    private timer: ReturnType<typeof setInterval> | null = null;
    private frame = 0;
    private label = "";
    private started = 0;
    private readonly enabled = !!process.stdout.isTTY;

    start(label: string): void {
        this.label = label;
        if (!this.enabled) return;
        if (this.timer) return;
        this.started = Date.now();
        this.render();
        this.timer = setInterval(() => this.render(), 90);
    }

    set(label: string): void {
        this.label = label;
    }

    stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
        process.stdout.write("\r\x1b[2K");
    }

    get running(): boolean {
        return this.timer !== null;
    }

    private render(): void {
        const secs = Math.floor((Date.now() - this.started) / 1000);
        const f = FRAMES[this.frame++ % FRAMES.length];
        process.stdout.write(
            `\r\x1b[2K${chalk.magenta(f)} ${chalk.dim(this.label)}${secs >= 2 ? chalk.dim(` (${secs}s · Ctrl+C to interrupt)`) : ""}`,
        );
    }
}
