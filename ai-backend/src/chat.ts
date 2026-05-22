/**
 * Chat orchestration: builds the streamText call with the system prompt and
 * the docs `search` tool, and exposes runChat() for the HTTP handler.
 */

import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { config } from "./config.js";
import { openrouter } from "./openrouter.js";
import { searchDocs } from "./search.js";

export const SYSTEM_PROMPT = `You are the assistant for the TON blockchain documentation.

Rules you MUST follow:
- Before answering any question, call the \`search\` tool to ground your answer in the real TON documentation. Search first, answer second.
- Base your answer only on the content returned by the \`search\` tool. If the docs do not cover the question, say so plainly instead of inventing an answer.
- Every answer MUST attach links to the documentation pages it draws from — this is required, not optional. Build each link as a Markdown link using the page title and URL path returned by the \`search\` tool: \`[Page title](https://docs.ton.org<path>)\` (for example, path "/foundations/smart-contracts" becomes \`[Smart contracts](https://docs.ton.org/foundations/smart-contracts)\`). Link pages inline where you reference them, and finish every answer with a short "Sources" section that lists the documentation pages you used as Markdown links. Never present a doc path as plain text — it must always be a clickable Markdown link.
- Reply in the same language the user wrote in.
- Be concise and technical. Prefer precise, actionable explanations over filler.`;

/**
 * The docs search tool exposed to the model. The model calls it with a query;
 * we return matching documentation pages with snippets.
 */
const search = tool({
  description:
    "Search the official TON blockchain documentation. Use this to find relevant doc pages before answering. Returns page titles, URL paths, and content snippets.",
  inputSchema: z.object({
    query: z.string().describe("The search query, in natural language or keywords."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(8)
      .describe("Maximum number of doc pages to return."),
  }),
  execute: async ({ query, limit }) => {
    return searchDocs(query, limit);
  },
});

/**
 * Run a chat turn. Resolves to the streamText result; the caller turns it
 * into a UI Message Stream response. `abortSignal` is the request signal so a
 * client disconnect aborts the upstream model call.
 */
export async function runChat(messages: UIMessage[], abortSignal: AbortSignal) {
  return streamText({
    model: openrouter.chat(config.model),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(messages),
    tools: { search },
    stopWhen: stepCountIs(5),
    toolChoice: "auto",
    abortSignal,
  });
}
