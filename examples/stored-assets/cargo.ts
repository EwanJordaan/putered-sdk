import { definePlugin, defineTool } from "@putered/sdk/plugins";
import { z } from "zod";
import rust from "./rust.asset.js"; // Generated once by the upload CLI; commit this reference.

export default definePlugin({
  name: "cargo-demo",
  execution: { backend: "native" },
  assets: { rust },
  tools: {
    run: defineTool({
      input: z.object({}),
      output: z.object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() }),
      handler: (_input, ctx) => ctx.exec(rust, "cargo", ["run", "--offline"], {
        env: { RUSTFLAGS: "-C linker=/usr/bin/gcc" },
      }),
    }),
  },
});
