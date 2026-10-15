import { Putered, PuteredError, type ErrorCode } from "@putered/sdk";
import { definePlugin, defineTool, defineAsset } from "@putered/sdk/plugins";
import { z } from "zod";

const plugin = definePlugin({
  name: "count",
  execution: { backend: "v8" },
  tools: {
    count: defineTool({
      input: z.object({ text: z.string(), multiplier: z.number().default(1) }),
      output: z.object({ words: z.number() }),
      handler: ({ text, multiplier }) => ({ words: text.length * multiplier }),
    }),
    echo: defineTool({ input: z.string(), output: z.string(), handler: value => value }),
  },
});
const failure = new PuteredError("Denied", "POLICY_DENIED");
const code: ErrorCode = failure.code;
const status: number = failure.status;
void code; void status;
// @ts-expect-error SDK error codes are a closed union.
const invalidCode: ErrorCode = "SOMETHING_RANDOM";
const client = new Putered({ baseUrl: "http://localhost:3000", apiKey: "x".repeat(32) });
const ref = await client.tools.use(plugin);
const environment = await client.environments.create({ tools: [ref] });
const result = await environment.tools.call(ref, "count", { text: "hi" });
// @ts-expect-error Saved metadata is immutable; callers cannot replace validation schemas.
ref.manifest.tools.count.outputSchema = { type: "string" };
const words: number = result.output.words;
const echoed: string = (await environment.tools.call(ref, "echo", "hi")).output;
void words; void echoed;
// @ts-expect-error An output field cannot be used as the wrong type.
const wrongOutput: string = result.output.words;
// @ts-expect-error Unknown tool names are rejected, not widened to string.
await environment.tools.call(ref, "missing", {});
// @ts-expect-error Input types come from the selected tool's schema.
await environment.tools.call(ref, "count", { text: 42 });
// @ts-expect-error Inputs are tied to the tool name, not a union of every tool's input.
await environment.tools.call(ref, "count", "wrong");
// @ts-expect-error Excess input fields are rejected for object literals.
await environment.tools.call(ref, "count", { text: "hi", missing: true });
// @ts-expect-error Streaming handles are not silently promised by this synchronous API.
await environment.tools.call(ref, "count", { text: "hi" }, { wait: false });
// @ts-expect-error This release does not pretend to implement team ACLs.
await client.tools.use(plugin, { visibility: "team" });
const unknownRef = await client.tools.use("tool_" + "0".repeat(64));
const unknownResult = await environment.tools.call(unknownRef, "count", { text: "hi" });
// @ts-expect-error A string reference cannot manufacture a typed output.
const unchecked: number = unknownResult.output.words;
const rebound = await client.tools.use(unknownRef.id, { definition: plugin });
const checked: number = (await environment.tools.call(rebound, "count", { text: "hi" })).output.words;
void checked;
defineTool({
  input: z.string(), output: z.object({ words: z.number() }),
  // @ts-expect-error Handlers must return their declared output type.
  handler: () => ({ words: "incorrect" }),
});

const binary = defineAsset({ id: "asset_" + "a".repeat(64), platform: "linux-x64", entrypoints: { cargo: "bin/cargo", rustc: "bin/rustc" } });
defineTool({
  input: z.object({ release: z.boolean() }),
  output: z.object({ stdout: z.string(), exitCode: z.number() }),
  handler: async ({ release }, context) => {
    const result = await context.exec(binary, "cargo", release ? ["build", "--release"] : ["build"]);
    // @ts-expect-error Binary entrypoints are inferred and cannot be widened by the call.
    await context.exec(binary, "unknown");
    // @ts-expect-error Binary arguments must be strings.
    await context.exec(binary, "cargo", [42]);
    return result;
  },
});
const uploaded = await client.assets.upload("./rust-toolchain", { platform: "linux-x64", entrypoints: { cargo: "bin/cargo" } });
const executablePath: string = uploaded.entrypoints.cargo;
void executablePath;
// @ts-expect-error Uploads retain the known entrypoint names.
uploaded.entrypoints.unknown;
// @ts-expect-error Uploaded references cannot be changed after validation.
uploaded.entrypoints.cargo = "other";
