import { Putered } from "@putered/sdk";
import cargo from "./cargo.mjs";

const apiKey = process.env.PUTERED_API_KEY;
if (!apiKey) throw new Error("Set PUTERED_API_KEY from the Putered console.");
const putered = new Putered({ apiKey });
const tool = await putered.tools.use(cargo);
const environment = await putered.environments.create({
  tools: [tool], settings: { timeoutMs: 120_000 },
});
const setup = await environment.exec(`mkdir -p src
printf '[package]\nname = "hello_putered"\nversion = "0.1.0"\nedition = "2021"\n' > Cargo.toml
printf 'fn main() { println!("Hello from uploaded Rust!"); }\n' > src/main.rs`);
if (setup.exitCode !== 0) throw new Error(setup.stderr);
const { output } = await environment.tools.call(tool, "run", {});
if (output.exitCode !== 0) throw new Error(output.stderr);
console.log(output.stdout); // Typed string. The executable was built inside the workspace.
