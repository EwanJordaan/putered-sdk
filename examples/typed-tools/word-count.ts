import { definePlugin, defineTool } from "@putered/sdk/plugins";
import { z } from "zod";

export default definePlugin({
  name: "word-count",
  execution: { backend: "v8" },
  tools: {
    count: defineTool({
      input: z.object({ text: z.string().max(100_000) }),
      output: z.object({ words: z.number().int().nonnegative() }),
      handler: ({ text }) => ({ words: text.trim() ? text.trim().split(/\s+/u).length : 0 }),
    }),
  },
});
