import { ToolLoopAgent, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { getAgentModel } from "../ai/ai.config";
import { defaultModelSpec, formatModelSpec } from "../ai/ai.config";
import { ActionTracker } from "../modes/agent/action-tracker";
import { ToolExecutor } from "../modes/agent/tool-executor";
import { createAgentTools, createReadOnlyTools } from "../modes/agent/agent-tools";
import { defaultAgentConfig, type ActionLog } from "../modes/agent/types";
import { createWebTools } from "../modes/plan/web-tools";
import { loadConfig, type PermissionMode, type RushClawConfig } from "./config";
import { loadMemory, type LoadedMemory } from "./memory";
import { PermissionGate, type Approver } from "./permissions";
import { buildSystemPrompt, type PromptMode } from "./system-prompt";
import { UsageTracker } from "./usage";
import { createTodoTool, type Todo } from "./todos";
import { compactedHistory, summarizeConversation } from "./compact";
import { SessionStore, newSessionId, titleFrom, type SessionData } from "./session";
import { createTaskTool } from "./subagent";
import { CheckpointStore, type RestoreResult, type Checkpoint } from "./checkpoints";

export type UserContent = Extract<ModelMessage, { role: "user" }>["content"];

/** Callbacks the engine uses to show progress. Every one is optional. */
export interface EngineUI {
    /** Streaming assistant text. */
    text?(delta: string): void;
    /** The current block of assistant text is complete (a tool call or the end follows). */
    textDone?(): void;
    toolCall?(name: string, input: unknown): void;
    toolResult?(name: string, output: unknown, input: unknown): void;
    toolError?(name: string, error: unknown, input: unknown): void;
    /** Status / warning lines (fallback switches, auto-compaction…). */
    info?(message: string): void;
    /** The agent updated its todo checklist. */
    todos?(todos: Todo[]): void;
    /** A sub-agent (task tool) called one of its tools. */
    subagentStep?(task: string, action: string): void;
}

export interface EngineOptions {
    root?: string;
    config?: RushClawConfig;
    /** Model spec, e.g. "gemini:gemini-3.5-flash-lite". */
    model?: string;
    permissionMode?: PermissionMode;
    /** "agent" can edit and run commands; "ask" is read-only. */
    mode?: Extract<PromptMode, "agent" | "ask">;
    approver?: Approver;
    ui?: EngineUI;
    /** Save the conversation after every turn so it can be resumed. */
    persist?: boolean;
}

export interface TurnResult {
    /** All assistant text produced in the turn. */
    text: string;
    aborted: boolean;
    /** Files written to disk during the turn (auto-edit mode). */
    written: string[];
}

export interface ApplyResult {
    applied: string[];
    rejected: string[];
    errors: string[];
    shellOutputs: string[];
}

/**
 * One conversation with the agent: message history, staged changes, usage and
 * tools. Shared by the chat REPL, headless mode, Ask/Plan modes and Telegram.
 */
export class AgentEngine {
    readonly root: string;
    config: RushClawConfig;
    readonly tracker = new ActionTracker();
    readonly executor: ToolExecutor;
    readonly gate: PermissionGate;
    usage = new UsageTracker();
    memory: LoadedMemory;
    modelSpec: string;
    permissionMode: PermissionMode;
    readonly mode: "agent" | "ask";
    ui: EngineUI;
    messages: ModelMessage[] = [];
    /** The agent's current checklist (todo_write). */
    todos: Todo[] = [];
    readonly checkpoints: CheckpointStore;
    readonly sessions: SessionStore;
    sessionId = newSessionId();
    private createdAt = new Date().toISOString();
    private readonly persist: boolean;
    /** Tools added by integrations (MCP, todo, sub-agents…). */
    extraTools: ToolSet = {};

    private notes: string[] = [];

    constructor(opts: EngineOptions = {}) {
        this.root = opts.root ?? process.cwd();
        this.config = opts.config ?? loadConfig(this.root);
        this.modelSpec = formatModelSpec(opts.model ?? defaultModelSpec(this.config.model));
        this.permissionMode = opts.permissionMode ?? this.config.permissionMode;
        this.mode = opts.mode ?? "agent";
        this.ui = opts.ui ?? {};
        this.gate = new PermissionGate(opts.approver);
        this.memory = loadMemory(this.root);

        const agentConfig = defaultAgentConfig(this.root, this.config.excludePatterns);
        if (this.mode === "ask") {
            agentConfig.tools.allowFileCreation = false;
            agentConfig.tools.allowFileModification = false;
            agentConfig.tools.allowFolderCreation = false;
            agentConfig.tools.allowShellExecution = false;
        }
        this.executor = new ToolExecutor(this.tracker, agentConfig);
        this.checkpoints = new CheckpointStore(this.root);
        this.sessions = new SessionStore(this.root);
        this.persist = opts.persist ?? false;
        this.setPermissionMode(this.permissionMode);
    }

    /** review = stage + approve diffs; auto-edit = write immediately, checkpoint per turn. */
    setPermissionMode(mode: PermissionMode): void {
        this.permissionMode = mode;
        this.executor.autoApply = this.mode === "agent" && mode === "auto-edit";
    }

    /** Restore the files changed by the most recent applied turn. */
    undo(): (RestoreResult & { checkpoint: Checkpoint }) | null {
        const res = this.checkpoints.undoLast();
        if (res && (res.restored.length || res.removed.length)) {
            const parts = [];
            if (res.restored.length) parts.push(`restored ${res.restored.join(", ")}`);
            if (res.removed.length) parts.push(`deleted the created file(s) ${res.removed.join(", ")}`);
            this.addNote(
                `The user ran /undo on your change "${res.checkpoint.label}": ${parts.join("; ")}. Those files are back to their previous content — re-read them before editing.`,
            );
        }
        return res;
    }

    get hasWeb(): boolean {
        return !!process.env.FIRECRAWL_API_KEY?.trim();
    }

    setModel(spec: string): void {
        this.modelSpec = formatModelSpec(spec);
    }

    reloadMemory(): LoadedMemory {
        this.memory = loadMemory(this.root);
        return this.memory;
    }

    /** Add a note that is prepended to the next user message (e.g. "user rejected X"). */
    addNote(note: string): void {
        this.notes.push(note);
    }

    tools(): ToolSet {
        const base: ToolSet =
            this.mode === "ask"
                ? createReadOnlyTools(this.executor)
                : createAgentTools(this.executor, {
                    gate: this.gate,
                    allowedCommands: this.config.allowedCommands,
                    commandTimeoutMs: this.config.commandTimeoutMs,
                    editsAreOnDisk: () => this.permissionMode === "auto-edit",
                });
        return {
            ...base,
            ...(this.mode === "agent" ? { todo_write: createTodoTool(this, (t) => this.ui.todos?.(t)) } : {}),
            task: createTaskTool(this),
            ...(this.hasWeb ? createWebTools(this.tracker) : {}),
            ...this.extraTools,
        };
    }

    systemPrompt(tools: ToolSet = this.tools()): string {
        const names = Object.keys(tools);
        return buildSystemPrompt({
            mode: this.mode,
            root: this.root,
            permissionMode: this.permissionMode,
            memory: this.memory,
            hasWeb: this.hasWeb,
            toolNames: names,
            mcpToolNames: names.filter((n) => n.startsWith("mcp__")),
        });
    }

    model() {
        return getAgentModel(this.modelSpec, {
            fallbacks: this.config.fallbackModels,
            onFallback: (from, to) => this.ui.info?.(`${from} is rate limited — falling back to ${to}`),
        });
    }

    private buildUserMessage(input: string | UserContent): ModelMessage {
        const notes = this.notes.splice(0);
        if (notes.length === 0) return { role: "user", content: input } as ModelMessage;
        const prefix = notes.map((n) => `[Note: ${n}]`).join("\n") + "\n\n";
        if (typeof input === "string") return { role: "user", content: prefix + input };
        return { role: "user", content: [{ type: "text", text: prefix }, ...input] } as ModelMessage;
    }

    /**
     * Replace the history with a summary of it. Runs automatically when the
     * context grows past config.compactAtTokens, or on /compact.
     */
    async compact(focus?: string): Promise<{ summary: string; messagesBefore: number } | null> {
        if (this.messages.length < 2) return null;
        const messagesBefore = this.messages.length;
        const { summary, usage, modelId } = await summarizeConversation(this.model(), this.messages, focus);
        if (!summary) throw new Error("The model returned an empty summary; history was kept.");
        this.usage.addStep(usage, modelId);
        this.messages = compactedHistory(summary, this.todos);
        this.usage.lastInputTokens = Math.round(summary.length / 4);
        this.save();
        return { summary, messagesBefore };
    }

    private async maybeAutoCompact(): Promise<void> {
        const limit = this.config.compactAtTokens;
        if (!limit || this.usage.lastInputTokens < limit || this.messages.length <= 2) return;
        this.ui.info?.(`Context is ~${Math.round(this.usage.lastInputTokens / 1000)}k tokens — compacting the conversation…`);
        try {
            const r = await this.compact();
            if (r) this.ui.info?.(`Compacted ${r.messagesBefore} messages into a summary.`);
        } catch (e) {
            this.ui.info?.(`Auto-compaction failed (${(e as Error).message}); continuing with full history.`);
        }
    }

    toSession(): SessionData {
        return {
            version: 1,
            id: this.sessionId,
            root: this.root,
            title: titleFrom(this.messages),
            createdAt: this.createdAt,
            updatedAt: new Date().toISOString(),
            mode: this.mode,
            model: this.modelSpec,
            permissionMode: this.permissionMode,
            messages: this.messages,
            todos: this.todos,
            usage: this.usage.toJSON(),
        };
    }

    /** Persist the conversation (no-op unless created with persist: true). */
    save(): void {
        if (!this.persist || this.messages.length === 0) return;
        try {
            this.sessions.save(this.toSession());
        } catch (e) {
            this.ui.info?.(`Could not save session: ${(e as Error).message}`);
        }
    }

    /** Continue a saved conversation. */
    loadSession(data: SessionData): void {
        this.sessionId = data.id;
        this.createdAt = data.createdAt;
        this.messages = data.messages ?? [];
        this.todos = data.todos ?? [];
        this.usage = UsageTracker.fromJSON(data.usage);
        if (data.model) this.setModel(data.model);
        if (data.permissionMode) this.setPermissionMode(data.permissionMode);
    }

    /** Run one user turn: stream the model, execute tools, append to history. */
    async runTurn(input: string | UserContent, signal?: AbortSignal): Promise<TurnResult> {
        await this.maybeAutoCompact();
        const tools = this.tools();
        const agent = new ToolLoopAgent({
            model: this.model(),
            instructions: this.systemPrompt(tools),
            tools,
            stopWhen: stepCountIs(this.config.maxSteps),
        });

        const userMsg = this.buildUserMessage(input);
        this.usage.startTurn();
        if (this.executor.autoApply) {
            const label = typeof input === "string" ? input : "turn";
            this.executor.checkpoint = this.checkpoints.begin(label.replace(/\s+/g, " ").slice(0, 80));
        }
        const ui = this.ui;
        const pendingInputs = new Map<string, unknown>();
        let text = "";
        let aborted = false;

        const result = await agent.stream({
            messages: [...this.messages, userMsg],
            abortSignal: signal,
        });

        try {
            for await (const part of result.fullStream) {
                switch (part.type) {
                    case "text-delta":
                        text += part.text;
                        ui.text?.(part.text);
                        break;
                    case "text-end":
                        ui.textDone?.();
                        break;
                    case "tool-call":
                        ui.textDone?.();
                        pendingInputs.set(part.toolCallId, part.input);
                        ui.toolCall?.(part.toolName, part.input);
                        break;
                    case "tool-result":
                        ui.toolResult?.(part.toolName, part.output, pendingInputs.get(part.toolCallId));
                        break;
                    case "tool-error":
                        ui.toolError?.(part.toolName, part.error, pendingInputs.get(part.toolCallId));
                        break;
                    case "finish-step":
                        this.usage.addStep(part.usage, part.response?.modelId);
                        break;
                    case "abort":
                        aborted = true;
                        break;
                    case "error":
                        throw part.error;
                }
            }
        } catch (err) {
            if (signal?.aborted) aborted = true;
            else throw err;
        } finally {
            ui.textDone?.();
            this.executor.checkpoint?.save();
            this.executor.checkpoint = null;
        }
        const written = this.executor.takeAutoApplied();

        let response: ModelMessage[] = [];
        try {
            response = (await result.responseMessages) as ModelMessage[];
        } catch {
            response = [];
        }
        if (aborted) {
            this.messages.push(userMsg, ...response, {
                role: "assistant",
                content: "(The user interrupted this turn before it finished.)",
            });
        } else {
            this.messages.push(userMsg, ...response);
        }
        this.save();
        return { text, aborted, written };
    }

    pending(): ActionLog[] {
        return this.tracker.getPendingMutations();
    }

    /**
     * Write approved actions to disk, reject the rest, and leave a note for the
     * model so it knows what actually happened to its changes.
     */
    applyApproved(): ApplyResult {
        const all = [...this.tracker.getActions()];
        for (const a of all) {
            if (a.status === "pending" && a.type !== "code_analysis")
                this.tracker.updateStatus(a.id, "rejected", false);
        }
        const rejected = [
            ...new Set(all.filter((a) => a.status === "rejected").map((a) => a.details.command ?? a.path)),
        ];
        const changed = all.filter((a) => a.status === "approved" && a.type !== "tool_execute").map((a) => a.path);
        this.executor.checkpoint = this.checkpoints.begin(`apply: ${[...new Set(changed)].slice(0, 4).join(", ")}`);
        let result: ReturnType<ToolExecutor["applyApprovedFromTracker"]>;
        try {
            result = this.executor.applyApprovedFromTracker();
        } finally {
            this.executor.checkpoint.save();
            this.executor.checkpoint = null;
        }
        const { errors, applied, shellOutputs } = result;

        if (applied.length)
            this.addNote(`The user approved your changes; they are now on disk: ${applied.join(", ")}.`);
        if (rejected.length)
            this.addNote(
                `The user REJECTED these staged changes, so they were NOT applied (files on disk are unchanged): ${rejected.join(", ")}.`,
            );
        if (errors.length) this.addNote(`Applying changes produced errors: ${errors.join("; ")}`);

        this.executor.clearStaging();
        this.tracker.clear();
        return { applied, rejected, errors, shellOutputs };
    }

    /** Reject everything that is staged. */
    rejectAll(): ApplyResult {
        for (const a of this.pending()) this.tracker.updateStatus(a.id, "rejected", false);
        return this.applyApproved();
    }

    /** Start a fresh conversation (keeps model, mode and integrations). */
    reset(): void {
        this.messages = [];
        this.notes = [];
        this.todos = [];
        this.sessionId = newSessionId();
        this.createdAt = new Date().toISOString();
        this.executor.clearStaging();
        this.tracker.clear();
        this.usage = new UsageTracker();
    }
}
