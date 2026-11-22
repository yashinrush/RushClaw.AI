import path from "node:path";
import type { ToolSet } from "ai";
import { createMCPClient } from "@ai-sdk/mcp";
import { StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { McpServerConfig } from "./config";
import type { PermissionGate } from "./permissions";

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

export interface McpServerStatus {
    name: string;
    ok: boolean;
    tools: string[];
    error?: string;
}

const CONNECT_TIMEOUT_MS = 20_000;

/** Tool names must be [a-zA-Z0-9_-] and ≤ 64 chars for Gemini / OpenAI-style APIs. */
export function mcpToolName(server: string, tool: string): string {
    const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

/**
 * Connects to the MCP servers in config.mcpServers (stdio commands or remote
 * http/sse URLs) and exposes their tools as `mcp__<server>__<tool>`. Each call
 * goes through the permission gate unless autoApproveMcpTools is set.
 */
export class McpManager {
    private clients: Array<{ name: string; client: MCPClient }> = [];
    status: McpServerStatus[] = [];
    tools: ToolSet = {};

    constructor(
        private readonly gate: PermissionGate,
        private readonly autoApprove: boolean,
    ) { }

    async connect(servers: Record<string, McpServerConfig>, root: string): Promise<McpServerStatus[]> {
        await Promise.all(
            Object.entries(servers).map(async ([name, cfg]) => {
                try {
                    const transport =
                        "url" in cfg
                            ? { type: cfg.type ?? "http", url: cfg.url, headers: cfg.headers }
                            : new StdioMCPTransport({
                                command: cfg.command,
                                args: cfg.args ?? [],
                                env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
                                cwd: cfg.cwd ? path.resolve(root, cfg.cwd) : root,
                                stderr: "ignore",
                            });
                    const client = await withTimeout(createMCPClient({ transport }), CONNECT_TIMEOUT_MS, `Connecting to "${name}"`);
                    this.clients.push({ name, client });
                    const serverTools = (await withTimeout(client.tools(), CONNECT_TIMEOUT_MS, `Listing tools of "${name}"`)) as ToolSet;
                    const names: string[] = [];
                    for (const [toolName, t] of Object.entries(serverTools)) {
                        const full = mcpToolName(name, toolName);
                        this.tools[full] = this.guard(name, toolName, t);
                        names.push(toolName);
                    }
                    this.status.push({ name, ok: true, tools: names });
                } catch (e) {
                    this.status.push({ name, ok: false, tools: [], error: (e as Error).message ?? String(e) });
                }
            }),
        );
        this.status.sort((a, b) => a.name.localeCompare(b.name));
        return this.status;
    }

    /** Ask before each MCP tool call (they can have side effects outside the repo). */
    private guard(server: string, toolName: string, t: ToolSet[string]): ToolSet[string] {
        const original = (t as any).execute as ((input: unknown, options: unknown) => Promise<unknown>) | undefined;
        if (!original || this.autoApprove) return t;
        return {
            ...(t as any),
            execute: async (input: unknown, options: unknown) => {
                const verdict = await this.gate.check({
                    kind: "mcp",
                    title: `Allow MCP tool ${server} › ${toolName}?`,
                    detail: JSON.stringify(input ?? {}, null, 2).slice(0, 1200),
                    alwaysKey: `mcp:${server}:${toolName}`,
                    alwaysLabel: `${server} › ${toolName}`,
                });
                if (verdict === "allowed") return original(input, options);
                if (verdict === "no-approver")
                    return `MCP tool ${server} › ${toolName} needs user approval, which isn't available here. Set "autoApproveMcpTools": true in rushclaw.config.json to allow it.`;
                return `The user denied the MCP tool call ${server} › ${toolName}.`;
            },
        } as any;
    }

    async close(): Promise<void> {
        await Promise.all(
            this.clients.map(async ({ client }) => {
                try {
                    await client.close();
                } catch { }
            }),
        );
        this.clients = [];
        this.tools = {};
    }
}
