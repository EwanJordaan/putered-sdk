# Putered SDK

The Putered TypeScript SDK connects Node.js applications to hosted Putered.
It creates and reconnects to persistent environments, runs commands, and can
call typed tools. Create an API key in the [Putered console](https://putered.com).

Requires Node.js 22.13 or later.

## Install

```sh
npm install @putered/sdk@0.2.0
```

To build a local tarball instead:

```sh
git clone https://github.com/EwanJordaan/putered-sdk.git
cd putered-sdk
npm ci
npm run build
npm pack
```

Install the generated tarball in your application with `npm install
/path/to/putered-sdk-<version>.tgz`.

## Connect to Putered

Set `PUTERED_API_KEY` in the application’s private environment, then create an
environment. The SDK uses hosted compute by default and adds `/v1` to its base
URL. Hosted compute requires an active subscription and available credits:

```ts
import { Putered } from '@putered/sdk';

const putered = new Putered({
  apiKey: process.env.PUTERED_API_KEY!,
});
const environment = await putered.environments.create();
await environment.exec("printf 'hello\\n' > hello.txt");
console.log((await environment.exec('cat hello.txt')).output);
console.log((await environment.run('git', ['status', '--short'])).output);

// Persist this ID to reconnect in a later process.
console.log(environment.id);
```

Create environments with top-level `persistence: "workspace"`,
`"workspace-and-dependencies"`, `"full"` or `"none"`, or a custom
`{ mode: "custom", include: [...], exclude: [...] }` policy. Set a default using
`{ "persistence": "workspace" }` in `putered.sdk.config.json`; explicit creation
options override it. Use `environment.stop()` and `environment.resume()`, or let
execution resume on demand. These APIs require the matching server and are not
yet in npm 0.2.0. See the [SDK guide](docs/sdk.md).

Environment naming in this checkout is unreleased; npm version 0.2.0 does not
yet accept the `name` option. Omit it when using that published version.

## Guides and examples

- [SDK guide](docs/sdk.md)
- [SDK and HTTP API contract](docs/api-contract.md)
- [Runnable SDK examples](examples/sdk/README.md)
- [Vibes starter](examples/vibes/README.md)
- [Typed tools example](examples/typed-tools/README.md)
- [Stored assets example](examples/stored-assets/README.md)
- [Response contracts](docs/sdk-response-contracts.md)
- [Publishing guide](docs/publishing.md)

The package exports `@putered/sdk`, `@putered/sdk/plugins`, and
`@putered/sdk/packaging`. See the SDK guide for plugin building, stored assets,
command results, and error handling.
