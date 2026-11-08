import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("bundled MCP transport exposes questions, memory and collaboration tools", async () => {
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer local-test-only");
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        result: { received: body.type, payload: body.payload },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({
    command: process.env.ALPHA_EXECUTABLE || process.execPath,
    args: [
      process.env.ALPHA_MCP_SCRIPT ||
        path.resolve("integration/alpha-tools.cjs"),
    ],
    env: {
      ALPHA_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
      ALPHA_SESSION_TOKEN: "local-test-only",
      ELECTRON_RUN_AS_NODE: "1",
    },
  });
  const client = new Client({ name: "alpha-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    const result = await client.callTool({
      name: "alpha_ask_question",
      arguments: {
        text: "Choose a color",
        area: "Design",
        options: ["Cyan", "Orange"],
      },
    });
    const response = JSON.parse(result.content[0].text);
    assert.equal(response.received, "ask_question");
    assert.equal(response.payload.text, "Choose a color");
    const recall = await client.callTool({
      name: "alpha_recall",
      arguments: { query: "test", budget: 1000 },
    });
    assert.equal(JSON.parse(recall.content[0].text).received, "recall");
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
