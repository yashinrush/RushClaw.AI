// Minimal stdio MCP server used by tests: one tool, "echo".
const rl = require("readline").createInterface({ input: process.stdin });

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (msg.id === undefined) return; // notification

    switch (msg.method) {
        case "initialize":
            return send({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                    protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
                    capabilities: { tools: {} },
                    serverInfo: { name: "echo", version: "1.0.0" },
                },
            });
        case "tools/list":
            return send({
                jsonrpc: "2.0",
                id: msg.id,
                result: {
                    tools: [
                        {
                            name: "echo",
                            description: "Echo text back",
                            inputSchema: {
                                type: "object",
                                properties: { text: { type: "string" } },
                                required: ["text"],
                            },
                        },
                    ],
                },
            });
        case "tools/call":
            return send({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: [{ type: "text", text: "echo: " + msg.params.arguments.text }] },
            });
        default:
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    }
});
