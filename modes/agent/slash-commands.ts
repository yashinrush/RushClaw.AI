import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { confirm, isCancel, select, text } from "@clack/prompts";
import type { AgentEngine } from "../../core/engine";
import { configPaths, PROJECT_CONFIG_FILE } from "../../core/config";
import { INIT_PROMPT, MEMORY_FILE } from "../../core/memory";
import { defaultModelSpec, formatModelSpec, hasProviderKey, parseModelSpec } from "../../ai/ai.config";
import { renderTerminalMarkdown } from "../../tui/terminal-md";

export interface SlashContext {
    engine: AgentEngine;
    /** Text after the command name. */
    args: string;
    /** Send a prompt to the agent as if the user typed it. */
    runPrompt(prompt: string): Promise<void>;
}

export type SlashResult = "exit" | void;

export interface SlashCommand {
    name: string;
    aliases?: string[];
    /** Argument hint shown in /help, e.g. "[model]". */
    args?: string;
    description: string;
    /** Hide from Ask (read-only) mode. */
    agentOnly?: boolean;
    run(ctx: SlashContext): Promise<SlashResult>;
}

const registry: SlashCommand[] = [];

export function registerSlash(...cmds: SlashCommand[]): void {
    for (const c of cmds) {
        const i = registry.findIndex((r) => r.name === c.name);
        if (i >= 0) registry[i] = c;
        else registry.push(c);
    }
}

export function findSlash(name: string): SlashCommand | undefined {
    const n = name.toLowerCase();
    return registry.find((c) => c.name === n || c.aliases?.includes(n));
}

export function allSlash(): SlashCommand[] {
    return [...registry];
}

/** Parse and run "/name args". Returns "exit" when the chat should end. */
export async function runSlash(line: string, ctx: Omit<SlashContext, "args">): Promise<SlashResult> {
    const m = line.trim().match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return;
    const cmd = findSlash(m[1]!);
    if (!cmd || (cmd.agentOnly && ctx.engine.mode === "ask")) {
        console.log(chalk.yellow(`Unknown command /${m[1]}. Type /help for the list.`));
        return;
    }
    return cmd.run({ ...ctx, args: m[2]!.trim() });
}

// ───────────────────────── built-in commands ─────────────────────────

registerSlash(
    {
        name: "help",
        aliases: ["?"],
        description: "Show available commands",
        async run({ engine }) {
            const rows = allSlash()
                .filter((c) => !(c.agentOnly && engine.mode === "ask"))
                .map((c) => {
                    const name = `/${c.name}${c.args ? " " + c.args : ""}`;
                    return `  ${chalk.cyan(name.padEnd(24))} ${c.description}`;
                });
            console.log(`\n${chalk.bold("Commands")}\n${rows.join("\n")}`);
            console.log(
                chalk.dim(
                    "\n  Tips: Ctrl+C interrupts a running turn · reference images with @path/to/image.png · end a line with \\ for multi-line input\n",
                ),
            );
        },
    },
    {
        name: "exit",
        aliases: ["quit", "q"],
        description: "Leave the chat",
        async run() {
            return "exit";
        },
    },
    {
        name: "clear",
        aliases: ["new", "reset"],
        description: "Start a new conversation (clears history and staged changes)",
        async run({ engine }) {
            engine.reset();
            console.log(chalk.green("✓ Started a new conversation."));
        },
    },
    {
        name: "cost",
        aliases: ["usage", "tokens"],
        description: "Show token usage (and estimated cost) for this session",
        async run({ engine }) {
            console.log(`\n${engine.usage.formatSummary(engine.config.pricing)}\n`);
        },
    },
    {
        name: "model",
        args: "[provider:model]",
        description: "Show or switch the model (e.g. /model openrouter:openrouter/auto)",
        async run({ engine, args }) {
            if (args) {
                engine.setModel(args);
                warnMissingKey(engine.modelSpec);
                console.log(chalk.green(`✓ Model set to ${engine.modelSpec}`));
                return;
            }
            const candidates = [
                engine.modelSpec,
                engine.config.model ? formatModelSpec(engine.config.model) : null,
                defaultModelSpec(),
                ...engine.config.fallbackModels.map(formatModelSpec),
                hasProviderKey("gemini") ? "gemini:gemini-3.5-flash-lite" : null,
                hasProviderKey("openrouter") ? "openrouter:openrouter/auto" : null,
            ].filter((x): x is string => !!x);
            const unique = [...new Set(candidates)];
            const choice = await select({
                message: `Current model: ${engine.modelSpec}`,
                options: [
                    ...unique.map((s) => ({
                        value: s,
                        label: s,
                        hint: s === engine.modelSpec ? "current" : hasProviderKey(parseModelSpec(s).provider) ? undefined : "no API key",
                    })),
                    { value: "__custom", label: "Other… (type a model id)" },
                ],
            });
            if (isCancel(choice)) return;
            let spec = choice as string;
            if (spec === "__custom") {
                const t = await text({
                    message: "Model (gemini:<id> or openrouter:<id>)",
                    placeholder: "openrouter:meta-llama/llama-3.3-70b-instruct:free",
                });
                if (isCancel(t) || !t.trim()) return;
                spec = t.trim();
            }
            engine.setModel(spec);
            warnMissingKey(engine.modelSpec);
            console.log(chalk.green(`✓ Model set to ${engine.modelSpec}`));
        },
    },
    {
        name: "init",
        description: `Analyze the codebase and generate ${MEMORY_FILE} (project memory)`,
        agentOnly: true,
        async run({ runPrompt, engine }) {
            await runPrompt(INIT_PROMPT);
            engine.reloadMemory();
        },
    },
    {
        name: "memory",
        args: "[reload]",
        description: `Show loaded memory files (${MEMORY_FILE}); "reload" re-reads them`,
        async run({ engine, args }) {
            const mem = args === "reload" ? engine.reloadMemory() : engine.memory;
            if (!mem.sources.length) {
                console.log(chalk.dim(`No memory loaded. Create ${MEMORY_FILE} in the project root (or run /init).`));
                return;
            }
            console.log(chalk.bold("\nLoaded memory"));
            for (const s of mem.sources) console.log(`  ${chalk.cyan(s.scope.padEnd(8))} ${s.path} ${chalk.dim(`(${s.chars} chars)`)}`);
            console.log(chalk.dim(`\n  Edit these files to change what RushClaw always knows; then /memory reload.\n`));
        },
    },
    {
        name: "config",
        description: "Show config file locations and key settings",
        async run({ engine }) {
            const p = configPaths(engine.root);
            const c = engine.config;
            console.log(
                [
                    "",
                    chalk.bold("Config"),
                    `  project  ${p.project} ${fs.existsSync(p.project) ? chalk.green("(found)") : chalk.dim("(not found)")}`,
                    `  user     ${p.user} ${fs.existsSync(p.user) ? chalk.green("(found)") : chalk.dim("(not found)")}`,
                    "",
                    `  model            ${engine.modelSpec}`,
                    `  fallbackModels   ${c.fallbackModels.join(", ") || chalk.dim("none")}`,
                    `  permissionMode   ${engine.permissionMode}`,
                    `  maxSteps         ${c.maxSteps}`,
                    `  allowedCommands  ${c.allowedCommands.length} prefixes`,
                    `  mcpServers       ${Object.keys(c.mcpServers).join(", ") || chalk.dim("none")}`,
                    `  hooks            pre ${c.hooks.preToolUse?.length ?? 0} · post ${c.hooks.postToolUse?.length ?? 0} · postApply ${c.hooks.postApply?.length ?? 0}`,
                    chalk.dim(`\n  See rushclaw.config.example.json for every option (copy it to ${PROJECT_CONFIG_FILE}).\n`),
                ].join("\n"),
            );
        },
    },
    {
        name: "save",
        args: "[file.md]",
        description: "Save this conversation as a Markdown file",
        async run({ engine, args }) {
            const name = args || (await askFilename());
            if (!name) return;
            if (!name.toLowerCase().endsWith(".md") || name.includes("..")) {
                console.log(chalk.yellow("Use a .md filename inside the project."));
                return;
            }
            const target = path.resolve(engine.root, name);
            if (fs.existsSync(target)) {
                const ok = await confirm({ message: `${name} exists. Overwrite?`, initialValue: false });
                if (isCancel(ok) || !ok) return;
            }
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, conversationMarkdown(engine), "utf8");
            console.log(chalk.green(`✓ Saved ${name}`));
        },
    },
);

async function askFilename(): Promise<string | null> {
    const t = await text({ message: "Filename", initialValue: "rushclaw-chat.md" });
    return isCancel(t) || !t.trim() ? null : t.trim();
}

function warnMissingKey(spec: string) {
    const { provider } = parseModelSpec(spec);
    if (!hasProviderKey(provider))
        console.log(chalk.yellow(`⚠️  No API key for ${provider} in .env — requests will fail until you add one.`));
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((p: any) => (p?.type === "text" ? p.text : p?.type === "image" ? "[image]" : ""))
        .filter(Boolean)
        .join("\n");
}

/** User and assistant text of the conversation (tool traffic omitted). */
export function conversationMarkdown(engine: AgentEngine): string {
    const out = [`# RushClaw conversation\n\n_${new Date().toISOString()} · ${engine.modelSpec}_\n`];
    for (const m of engine.messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        const t = contentText(m.content).trim();
        if (!t) continue;
        out.push(`## ${m.role === "user" ? "You" : "RushClaw"}\n\n${t}\n`);
    }
    return out.join("\n");
}

export function printMarkdown(md: string): void {
    console.log(renderTerminalMarkdown(md));
}
