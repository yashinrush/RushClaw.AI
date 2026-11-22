import { spawn } from "node:child_process";

export interface ShellResult {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
}

export interface ShellOptions {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Written to the process' stdin, then stdin is closed. */
    input?: string;
    env?: Record<string, string>;
}

const MAX_CAPTURE = 2 * 1024 * 1024;

/** Run a command through the system shell without blocking the event loop. */
export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
    return new Promise((resolve) => {
        const child = spawn(command, {
            shell: true,
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            windowsHide: true,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let aborted = false;
        let settled = false;

        const kill = () => {
            try {
                child.kill("SIGTERM");
            } catch { }
        };

        const timer =
            opts.timeoutMs && opts.timeoutMs > 0
                ? setTimeout(() => {
                    timedOut = true;
                    kill();
                }, opts.timeoutMs)
                : null;

        const onAbort = () => {
            aborted = true;
            kill();
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", (d: Buffer) => {
            if (stdout.length < MAX_CAPTURE) stdout += d.toString("utf8");
        });
        child.stderr?.on("data", (d: Buffer) => {
            if (stderr.length < MAX_CAPTURE) stderr += d.toString("utf8");
        });

        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            opts.signal?.removeEventListener("abort", onAbort);
            resolve({ code, stdout, stderr, timedOut, aborted });
        };

        child.on("error", (err) => {
            stderr += String(err?.message ?? err);
            finish(127);
        });
        child.on("close", (code) => finish(code));

        if (opts.input !== undefined) {
            child.stdin?.on("error", () => { });
            child.stdin?.end(opts.input);
        } else {
            child.stdin?.end();
        }
    });
}

/** Keep the head and tail of long output so errors at the end are not lost. */
export function clipMiddle(text: string, max = 30_000): string {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.4);
    const tail = max - head;
    return (
        text.slice(0, head) +
        `\n…[${text.length - max} characters omitted]…\n` +
        text.slice(text.length - tail)
    );
}

export function formatShellResult(command: string, r: ShellResult): string {
    const parts = [`$ ${command}`];
    if (r.timedOut) parts.push("(timed out — process was killed)");
    if (r.aborted) parts.push("(cancelled by user)");
    parts.push(`exit code: ${r.code ?? "unknown"}`);
    const out = [r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n");
    parts.push(out ? clipMiddle(out) : "(no output)");
    return parts.join("\n");
}
