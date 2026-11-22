import path from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentEngine } from "../core/engine";
import { defaultRushClawConfig } from "../core/config";
import { mcpToolName } from "../core/mcp";
import type { PermissionAnswer } from "../core/permissions";
import { scriptedModel, tempWorkspace } from "./helpers";

const SERVER = path.join(import.meta.dir, "fixtures", "echo-mcp-server.cjs");

function mcpEngine(answer: PermissionAnswer, autoApprove = false) {
    const { model } = scriptedModel([
        { tool: "mcp__echo__echo", input: { text: "hi" } },
        { text: "done" },
    ]);
    class E extends AgentEngine {
        override model() {
            return model as any;
        }
    }
    const asked: string[] = [];
    const engine = new E({
        root: tempWorkspace(),
        model: "gemini:test",
        config: {
            ...defaultRushClawConfig(),
            mcpServers: { echo: { command: "node", args: [SERVER] } },
            autoApproveMcpTools: autoApprove,
        },
        approver: {
            ask: async (req) => {
                asked.push(req.title);
                return answer;
            },
        },
    });
    return { engine, asked };
}

describe("MCP", () => {
    test("tool names are sanitized and prefixed", () => {
        expect(mcpToolName("my server", "get.issue")).toBe("mcp__my_server__get_issue");
    });

    test("connects to a stdio server and calls its tool after approval", async () => {
        const { engine, asked } = mcpEngine("yes");
        const status = await engine.connectMcp();
        expect(status).toEqual([{ name: "echo", ok: true, tools: ["echo"] }]);
        expect(Object.keys(engine.tools())).toContain("mcp__echo__echo");

        const outputs: unknown[] = [];
        engine.ui.toolResult = (_n, o) => outputs.push(o);
        await engine.runTurn("echo hi");
        await engine.close();
        expect(asked).toEqual(["Allow MCP tool echo › echo?"]);
        expect(JSON.stringify(outputs[0])).toContain("echo: hi");
    }, 30_000);

    test("denied calls are reported to the model", async () => {
        const { engine } = mcpEngine("no");
        await engine.connectMcp();
        const outputs: unknown[] = [];
        engine.ui.toolResult = (_n, o) => outputs.push(o);
        await engine.runTurn("echo hi");
        await engine.close();
        expect(String(outputs[0])).toContain("denied");
    }, 30_000);

    test("unreachable servers fail gracefully", async () => {
        const engine = new AgentEngine({
            root: tempWorkspace(),
            model: "gemini:test",
            config: { ...defaultRushClawConfig(), mcpServers: { broken: { command: "this-command-does-not-exist-xyz" } } },
        });
        const status = await engine.connectMcp();
        await engine.close();
        expect(status[0]!.ok).toBe(false);
        expect(status[0]!.error).toBeTruthy();
    }, 30_000);
});
