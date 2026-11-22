import {
    Output,
    extractJsonMiddleware,
    generateText,
    stepCountIs,
    wrapLanguageModel,
} from "ai";
import { z } from "zod";
import chalk from "chalk";
import { spinner } from "@clack/prompts";
import { getAgentModel } from "../../ai/ai.config.ts";
import { ActionTracker } from "../agent/action-tracker.ts";
import { ToolExecutor } from "../agent/tool-executor.ts";
import { defaultAgentConfig } from "../agent/types.ts";
import type { Plan, PlanStep } from "./types.ts";
import { createWebTools } from "./web-tools.ts";
import { createReadOnlyTools } from "../agent/agent-tools.ts";
import { buildSystemPrompt } from "../../core/system-prompt.ts";
import { loadMemory } from "../../core/memory.ts";

const planSchema = z.object({
    researchSummary: z.string().optional(),
    steps: z
        .array(
            z.object({
                title: z.string(),
                description: z.string(),
                hints: z.array(z.string()).optional(),
                complexity: z.enum(["low", "medium", "high"]).optional(),
            }),
        )
        .min(1)
        .max(15),
});

const PLAN_INSTRUCTIONS = (codebase: string, hasWeb: boolean) =>
    [
        buildSystemPrompt({ mode: "plan", root: codebase, hasWeb, memory: loadMemory(codebase) }),
        "Output must match the provided JSON schema.",
    ].join("\n\n");

export async function generatePlan(goal: string) {
    const config = defaultAgentConfig();
    const tracker = new ActionTracker();
    const executor = new ToolExecutor(tracker, config);


    const hasWeb = !!process.env.FIRECRAWL_API_KEY;
    const model = wrapLanguageModel({
        model: getAgentModel(),
        middleware: extractJsonMiddleware()
    })


    const tools = { ...createReadOnlyTools(executor), ...(hasWeb ? createWebTools(tracker) : {}) };

    const s = spinner();
    s.start("Researching codebase and drafting plan...");

    try {
        const result = await generateText({
            model,
            tools,
            stopWhen: stepCountIs(20),
            system: PLAN_INSTRUCTIONS(config.codebasePath, hasWeb),
            prompt: `User goal: \n${goal}`,
            output: Output.object({ schema: planSchema }),
            onStepFinish: ({ toolCalls }) => {
                if (toolCalls && toolCalls.length > 0) {
                    const names = toolCalls.map((t) => t?.toolName).filter(Boolean).join(", ");
                    s.message(`Researching via ${chalk.cyan(names)}...`);
                }
            },
        });
        s.stop("Plan drafted successfully!");

        const validated = planSchema.parse(result.output);

        const steps: PlanStep[] = validated.steps.map((s, i) => ({
            id: `step-${i + 1}`,
            title: s.title,
            description: s.description,
            hints: s.hints,
            complexity: s.complexity
        }));

        return { goal, researchSummary: validated.researchSummary, steps };
    } catch (err) {
        s.stop("Failed to draft plan");
        throw err;
    }
}