import { tool } from "ai";
import { z } from "zod";
import type { ToolExecutor } from "./tool-executor";

/**
 * Read-only workspace tools. Shared by Agent, Ask, Plan, sub-agents and Telegram
 * so every mode sees the same (staged-aware) view of the codebase.
 */
export function createReadOnlyTools(executor: ToolExecutor) {
    return {
        read_file: tool({
            description:
                "Read a text file from the workspace (path relative to the project root). Returns the staged version if the file has pending edits. For large files pass offset (1-based start line) and limit (number of lines).",
            inputSchema: z.object({
                path: z.string().describe("Relative file path"),
                offset: z.number().int().min(1).optional().describe("1-based line to start reading from"),
                limit: z.number().int().min(1).optional().describe("Number of lines to read"),
            }),
            execute: async ({ path: p, offset, limit }) => executor.readFile(p, offset, limit),
        }),

        list_files: tool({
            description: "List files and directories under a path (staged new files are marked '(staged)').",
            inputSchema: z.object({
                path: z.string(),
                recursive: z.boolean().optional().default(false),
            }),
            execute: async ({ path: p, recursive }) =>
                executor.listFiles(p, recursive),
        }),

        search_files: tool({
            description:
                'Find files by name with a glob pattern (e.g. "*.ts", "src/**/*.test.ts"). Optional plain-substring content filter. To search inside files use grep instead.',
            inputSchema: z.object({
                root: z.string().describe("Directory to search, relative to root"),
                pattern: z
                    .string()
                    .describe("Glob-like pattern using * and ** (forward slashes)"),
                content_contains: z.string().optional(),
            }),
            execute: async ({ root, pattern, content_contains }) =>
                executor.searchFiles(root, pattern, content_contains),
        }),

        grep: tool({
            description:
                "Search file contents with a JavaScript regular expression. Returns `path:line: text` for each match (staged edits included). Use this to find definitions, usages and strings before reading files.",
            inputSchema: z.object({
                pattern: z.string().describe("Regular expression, e.g. 'function\\s+runAgent' or 'TODO'"),
                path: z.string().optional().describe("Directory or file to search (default: project root)"),
                glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts" or "modes/**"'),
                ignore_case: z.boolean().optional(),
                context: z.number().int().min(0).max(10).optional().describe("Lines of context around each match"),
                files_only: z.boolean().optional().describe("Return only the matching file paths"),
            }),
            execute: async ({ pattern, path: p, glob, ignore_case, context, files_only }) =>
                executor.grep(pattern, {
                    path: p,
                    glob,
                    ignoreCase: ignore_case,
                    context,
                    filesOnly: files_only,
                }),
        }),

        analyze_codebase: tool({
            description:
                "Summarize structure: file counts, size, extensions. Read-only.",
            inputSchema: z.object({
                path: z.string().default("."),
            }),
            execute: async ({ path: p }) => executor.analyzeCodebase(p),
        }),

        list_skills: tool({
            description:
                "List absolute paths to SKILL.md files under configured skill directories (Cursor / Claude).",
            inputSchema: z.object({}),
            execute: async () => executor.listSkills(),
        }),

        read_skill: tool({
            description:
                "Read a SKILL.md file. Path must be absolute and under skill roots, or use a path returned by list_skills.",
            inputSchema: z.object({
                path: z.string(),
            }),
            execute: async ({ path: p }) => executor.readSkill(p),
        }),
    };
}

export function createAgentTools(executor: ToolExecutor) {
    return {
        ...createReadOnlyTools(executor),

        create_file: tool({
            description:
                "Create a NEW file with the given content. Fails if the file already exists (use edit_file for existing files).",
            inputSchema: z.object({
                path: z.string(),
                content: z.string(),
            }),
            execute: async ({ path: p, content }) => executor.createFile(p, content),
        }),

        edit_file: tool({
            description: [
                "Edit an existing file by exact string replacement. This is the preferred way to change code.",
                "- Read the file first; old_string must match the current content EXACTLY, including indentation and whitespace.",
                "- old_string must be unique in the file: include 2-4 surrounding lines for context. Set replace_all to change every occurrence (e.g. renames).",
                "- Keep each edit small and focused; call edit_file several times for several changes.",
            ].join("\n"),
            inputSchema: z.object({
                path: z.string(),
                old_string: z.string().describe("Exact text to replace"),
                new_string: z.string().describe("Replacement text"),
                replace_all: z.boolean().optional().default(false),
            }),
            execute: async ({ path: p, old_string, new_string, replace_all }) =>
                executor.editFile(p, old_string, new_string, replace_all),
        }),

        modify_file: tool({
            description:
                "Replace the ENTIRE content of an existing file. Only use this for full rewrites; prefer edit_file for normal changes.",
            inputSchema: z.object({
                path: z.string(),
                content: z.string().describe("Complete new file contents"),
            }),
            execute: async ({ path: p, content }) => executor.modifyFile(p, content),
        }),

        delete_file: tool({
            description: "Delete a file.",
            inputSchema: z.object({
                path: z.string(),
            }),
            execute: async ({ path: p }) => executor.deleteFile(p),
        }),

        create_folder: tool({
            description:
                "Create a directory tree (mkdir -p). Not needed before create_file — parent folders are created automatically.",
            inputSchema: z.object({
                path: z.string().describe("Relative directory path"),
            }),
            execute: async ({ path: p }) => executor.createFolder(p),
        }),

        execute_shell: tool({
            description:
                "Queue a shell command to run in the workspace after user approval. Use with care.",
            inputSchema: z.object({
                command: z.string().describe("Single command; runs with shell: true"),
            }),
            execute: async ({ command }) => executor.queueShell(command),
        }),
    };
}
