import { Putered } from "@putered/sdk";
import wordCount from "./word-count.mjs";

const apiKey = process.env.PUTERED_API_KEY;
const baseUrl = process.env.PUTERED_BASE_URL;
if (!apiKey || !baseUrl) throw new Error("Set PUTERED_API_KEY and PUTERED_BASE_URL.");
const putered = new Putered({ apiKey, baseUrl });

// A single call: private upload on first use, content-addressed reuse thereafter.
const tool = await putered.tools.use(wordCount);
const environment = await putered.environments.create({
  tools: [tool], settings: { execution: { mode: "isolate-only" } },
});
const result = await environment.tools.call(
  tool, "count", { text: "A simple program using my own tool." }, { wait: true },
);
const words: number = result.output.words; // Inferred from the plugin's output schema.
const report = await environment.exec(
  `printf 'Word count: ${words}\\n' > report.txt && cat report.txt`, { wait: true },
);
if (report.exitCode !== 0) throw new Error(report.stderr);
console.log(report.stdout);
console.log(`Saved tool: ${tool.id}\nReconnect to environment: ${environment.id}`);
