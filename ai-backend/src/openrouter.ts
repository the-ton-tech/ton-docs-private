/**
 * OpenRouter provider instance for the AI SDK.
 *
 * The HTTP-Referer and X-Title headers are OpenRouter's recommended
 * attribution headers — they identify this app in OpenRouter's dashboard.
 */

import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "./config.js";

export const openrouter = createOpenRouter({
  apiKey: config.openrouterKey,
  headers: {
    "HTTP-Referer": "https://docs.ton.org",
    "X-Title": "TON Docs Assistant",
  },
});
