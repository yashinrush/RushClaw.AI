import chalk from "chalk";
import { tool } from "ai";
import { z } from "zod";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
    content: string;
    status: TodoStatus;
}

/**
 * todo_write lets the agent keep a visible checklist for multi-step work.
 * The whole list is replaced on every call (simple and robust for models).
 */
export function createTodoTool(state: { todos: Todo[] }, onUpdate?: (todos: Todo[]) => void) {
    return tool({
        description: [
            "Create or update your task checklist for the current request. Pass the FULL list every time (it replaces the previous one).",
            "Use it for work with 3+ steps: write the plan first, mark exactly one item in_progress while you work on it, and mark items completed as soon as they are done.",
            "Skip it for trivial one-step requests.",
        ].join("\n"),
        inputSchema: z.object({
            todos: z
                .array(
                    z.object({
                        content: z.string().min(1).describe("Imperative description, e.g. 'Add input validation to signup form'"),
                        status: z.enum(["pending", "in_progress", "completed"]),
                    }),
                )
                .max(30),
        }),
        execute: async ({ todos }) => {
            state.todos = todos;
            onUpdate?.(todos);
            const done = todos.filter((t) => t.status === "completed").length;
            return `Todo list updated (${done}/${todos.length} completed).`;
        },
    });
}

export function formatTodos(todos: Todo[]): string {
    if (!todos.length) return chalk.dim("  (no todos)");
    return todos
        .map((t) => {
            if (t.status === "completed") return `  ${chalk.green("☒")} ${chalk.dim.strikethrough(t.content)}`;
            if (t.status === "in_progress") return `  ${chalk.yellow("◐")} ${chalk.bold(t.content)}`;
            return `  ${chalk.dim("☐")} ${t.content}`;
        })
        .join("\n");
}
