# Putered SDK

The Putered TypeScript SDK connects Node.js applications to a Putered server.
It creates and reconnects to persistent environments, runs commands, and can
call typed tools. The server is installed and operated separately.

Requires Node.js 22.13 or later. The package is not currently published to npm.

## Install

```sh
npm install github:EwanJordaan/putered-sdk
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

## Connect to a server

Set `PUTERED_BASE_URL` and `PUTERED_API_KEY` in the application’s private
environment, then create an environment. Hosted compute requires an active
subscription and available credits. The SDK adds `/v1` to the base URL:

```ts
import { Putered } from '@putered/sdk';

const putered = new Putered({
  baseUrl: process.env.PUTERED_BASE_URL ?? 'https://putered.com/api/compute',
  apiKey: process.env.PUTERED_API_KEY!,
});
const environment = await putered.environments.create();
await environment.exec("printf 'hello\\n' > hello.txt");
console.log((await environment.exec('cat hello.txt')).output);

// Persist this ID to reconnect in a later process.
console.log(environment.id);
```

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
