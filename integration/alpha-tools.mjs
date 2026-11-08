import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "alpha", version: "0.1.0" });
const call = async (type, payload) => {
  const response = await fetch(`${process.env.ALPHA_ENDPOINT}/tool`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.ALPHA_SESSION_TOKEN}`,
    },
    body: JSON.stringify({ type, payload }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || body.error)
    throw new Error(body.error || "Alpha unavailable");
  return { content: [{ type: "text", text: JSON.stringify(body.result) }] };
};
const register = (name, description, schema, type) =>
  server.registerTool(
    name,
    { description, inputSchema: schema },
    async (payload) => {
      try {
        return await call(type, payload);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    },
  );
register(
  "alpha_windows",
  "List windows in this project for collaboration.",
  {},
  "windows",
);
register(
  "alpha_send_message",
  "Send a message to another window in this project. It appears in its inbox; it is not executed as a shell command.",
  { to: z.string(), body: z.string() },
  "send_message",
);
register(
  "alpha_inbox",
  "Read messages addressed to this window. Check while collaborating or waiting for human answers.",
  { markRead: z.boolean().optional() },
  "inbox",
);
register(
  "alpha_recall",
  "Retrieve only task-relevant shared and current-project memory. Pinned instructions are prioritized. If omittedPinned is nonempty, ask the user to shorten them or raise the budget; do not silently ignore required instructions.",
  { query: z.string(), budget: z.number().min(128).max(12000).optional() },
  "recall",
);
register(
  "alpha_remember",
  "Save useful learned knowledge. Default to Alpha shared, but set projectSpecific for requirements, local decisions, story facts or other knowledge belonging only to this project. Explicit scope overrides automatic classification. Do not store credentials or full transcripts.",
  {
    title: z.string(),
    content: z.string(),
    scope: z.enum(["alpha", "project"]).optional(),
    projectSpecific: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    pinned: z.boolean().optional(),
    links: z.array(z.string()).optional(),
  },
  "remember",
);
register(
  "alpha_skills",
  "Read shared skills plus skills specific to this project.",
  {},
  "skills",
);
register(
  "alpha_ask_question",
  "Ask the human through the central Questions section. Return the question ID, hold dependent work, and continue independent work. Options are suggestions, never answers.",
  {
    text: z.string(),
    context: z.string().optional(),
    area: z.string().optional(),
    options: z.array(z.string()).max(6).optional(),
  },
  "ask_question",
);
register(
  "alpha_questions",
  "Read this window's questions and actual human answers. Pending means no answer yet.",
  {},
  "questions",
);
register(
  "alpha_resolve_question",
  "Mark an answered question resolved after applying its human answer.",
  { id: z.string() },
  "resolve_question",
);
server.connect(new StdioServerTransport()).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
