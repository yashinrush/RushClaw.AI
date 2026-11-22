/**
 * Mid-turn permission prompts (shell commands outside the allowlist, MCP tools).
 * The CLI plugs in an interactive approver; headless / Telegram run without one,
 * in which case risky actions are denied or queued for end-of-turn approval.
 */

export type PermissionAnswer = "yes" | "always" | "no";

export interface PermissionRequest {
    kind: "command" | "mcp";
    /** Short title, e.g. "Run command?" */
    title: string;
    /** What will happen, e.g. the full command line. */
    detail: string;
    /** Key remembered when the user picks "always" (e.g. "cmd:npm run"). */
    alwaysKey: string;
    /** Human label for the "always" choice, e.g. "`npm run …` commands". */
    alwaysLabel: string;
}

export interface Approver {
    ask(req: PermissionRequest): Promise<PermissionAnswer>;
}

export type GateResult = "allowed" | "denied" | "no-approver";

export class PermissionGate {
    private readonly always = new Set<string>();

    constructor(public approver?: Approver) { }

    isAlwaysAllowed(key: string): boolean {
        return this.always.has(key);
    }

    allowAlways(key: string): void {
        this.always.add(key);
    }

    alwaysAllowedKeys(): string[] {
        return [...this.always].sort();
    }

    async check(req: PermissionRequest): Promise<GateResult> {
        if (this.always.has(req.alwaysKey)) return "allowed";
        if (!this.approver) return "no-approver";
        const answer = await this.approver.ask(req);
        if (answer === "always") this.always.add(req.alwaysKey);
        return answer === "no" ? "denied" : "allowed";
    }
}

/** Characters that let a command chain or redirect into something else. */
const SHELL_META = /[;&|<>`$\n\r()]/;

/**
 * True when `command` starts with one of the allowlisted prefixes and contains
 * no shell operators — so "git status" is allowed but "git status; rm -rf ." is not.
 */
export function isCommandAllowed(command: string, allowed: string[]): boolean {
    const c = command.trim().replace(/\s+/g, " ");
    if (!c || SHELL_META.test(c)) return false;
    if (/(^|\s)--output(=|\s|$)/.test(c)) return false;
    return allowed.some((p) => {
        const q = p.trim().replace(/\s+/g, " ");
        return q.length > 0 && (c === q || c.startsWith(q + " "));
    });
}

/** "npm run build --prod" -> "npm run"; "pytest -x" -> "pytest". Used for "always allow". */
export function commandFamily(command: string): string {
    const words = command.trim().split(/\s+/);
    const first = words[0] ?? "";
    const second = words[1];
    if (second && !second.startsWith("-") && /^[a-z][\w:-]*$/i.test(second))
        return `${first} ${second}`;
    return first;
}
