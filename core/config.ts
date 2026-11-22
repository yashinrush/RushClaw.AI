import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";

/** A shell command run on a tool / apply event. See core/hooks.ts. */
export interface HookConfig {
    /** Regex matched against the tool name (PreToolUse/PostToolUse). Omit to match every tool. */
    matcher?: string;
    command: string;
    timeoutMs?: number;
}

export interface HooksConfig {
    preToolUse?: HookConfig[];
    postToolUse?: HookConfig[];
    /** Runs after staged changes are written to disk. */
    postApply?: HookConfig[];
}

export type McpServerConfig =
    | {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;
    }
    | {
        type: "http" | "sse";
        url: string;
        headers?: Record<string, string>;
    };

/**
 * review    – edits are staged and reviewed as diffs at the end of each turn (default)
 * auto-edit – edits are written to disk immediately; every turn is checkpointed so /undo works
 */
export type PermissionMode = "review" | "auto-edit";

/** USD per 1M tokens. */
export interface ModelPrice {
    input: number;
    output: number;
}

export interface RushClawConfig {
    /** "gemini:<model>" or "openrouter:<model>". Falls back to env vars when unset. */
    model?: string;
    /** Models to try automatically when the active one is rate limited or overloaded. */
    fallbackModels: string[];
    maxSteps: number;
    subagentMaxSteps: number;
    excludePatterns: string[];
    /** Command prefixes the agent may run without asking (run_command). */
    allowedCommands: string[];
    commandTimeoutMs: number;
    permissionMode: PermissionMode;
    /** Auto-compact the conversation when the context reaches this many input tokens. 0 disables. */
    compactAtTokens: number;
    /** Skip the permission prompt for MCP tool calls. */
    autoApproveMcpTools: boolean;
    hooks: HooksConfig;
    mcpServers: Record<string, McpServerConfig>;
    /** Optional pricing table used by /cost, keyed by model id. */
    pricing: Record<string, ModelPrice>;
}

export const DEFAULT_ALLOWED_COMMANDS = [
    "bun test",
    "bun run test",
    "bun run lint",
    "bun run typecheck",
    "bun run build",
    "bunx tsc --noEmit",
    "tsc --noEmit",
    "npx tsc --noEmit",
    "npm test",
    "npm run test",
    "npm run lint",
    "npm run build",
    "pnpm test",
    "pnpm run test",
    "yarn test",
    "pytest",
    "python -m pytest",
    "go test",
    "go build",
    "go vet",
    "cargo test",
    "cargo check",
    "cargo build",
    "git status",
    "git diff",
    "git log",
    "git show",
    "ls",
    "dir",
    "pwd",
    "node --version",
    "bun --version",
];

export const DEFAULT_EXCLUDE_PATTERNS = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "*.log",
    ".env*",
];

export function defaultRushClawConfig(): RushClawConfig {
    return {
        model: undefined,
        fallbackModels: [],
        maxSteps: 40,
        subagentMaxSteps: 25,
        excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
        allowedCommands: [...DEFAULT_ALLOWED_COMMANDS],
        commandTimeoutMs: 120_000,
        permissionMode: "review",
        compactAtTokens: 120_000,
        autoApproveMcpTools: false,
        hooks: {},
        mcpServers: {},
        pricing: {},
    };
}

export const PROJECT_CONFIG_FILE = "rushclaw.config.json";

/** ~/.rushclaw (override with RUSHCLAW_HOME). */
export function rushclawHome(): string {
    return process.env.RUSHCLAW_HOME?.trim() || path.join(homedir(), ".rushclaw");
}

/** Per-project data folder (sessions, checkpoints) under ~/.rushclaw/projects. */
export function projectDataDir(root: string): string {
    const slug = path
        .resolve(root)
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(-120);
    return path.join(rushclawHome(), "projects", slug || "root");
}

function readJson(file: string): Record<string, unknown> | null {
    if (!fs.existsSync(file)) return null;
    try {
        const raw = fs.readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        console.warn(chalk.yellow(`⚠️  Ignoring ${file}: top level must be a JSON object.`));
    } catch (e) {
        console.warn(chalk.yellow(`⚠️  Ignoring ${file}: ${(e as Error).message}`));
    }
    return null;
}

/**
 * Merge config layers. Scalars and arrays from later layers replace earlier ones;
 * `hooks`, `mcpServers` and `pricing` are merged key by key.
 */
export function mergeConfig(
    base: RushClawConfig,
    ...layers: Array<Record<string, unknown> | null>
): RushClawConfig {
    const out: RushClawConfig = {
        ...base,
        hooks: { ...base.hooks },
        mcpServers: { ...base.mcpServers },
        pricing: { ...base.pricing },
    };
    for (const layer of layers) {
        if (!layer) continue;
        for (const [k, v] of Object.entries(layer)) {
            if (v === undefined || k.startsWith("$")) continue;
            if (k === "hooks" || k === "mcpServers" || k === "pricing") {
                if (v && typeof v === "object")
                    Object.assign((out as any)[k], v);
                continue;
            }
            if (k in out || k === "model") (out as any)[k] = v;
        }
    }
    if (out.permissionMode !== "review" && out.permissionMode !== "auto-edit")
        out.permissionMode = "review";
    return out;
}

/** Load ~/.rushclaw/config.json, then <root>/rushclaw.config.json on top. */
export function loadConfig(root: string = process.cwd()): RushClawConfig {
    const user = readJson(path.join(rushclawHome(), "config.json"));
    const project = readJson(path.join(root, PROJECT_CONFIG_FILE));
    return mergeConfig(defaultRushClawConfig(), user, project);
}

/** Paths a user can edit to configure RushClaw for this project. */
export function configPaths(root: string = process.cwd()) {
    return {
        user: path.join(rushclawHome(), "config.json"),
        project: path.join(root, PROJECT_CONFIG_FILE),
    };
}
