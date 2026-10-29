# Vibes

A local workbench that builds your React app inside a persistent Putered environment.
Your API key stays in the local Node process. No AI provider key is required.

Use Node 24.5 or later and a Putered account. In this directory:

```powershell
Copy-Item .env.example .env
notepad .env
npm install
npm start
```

Set `PUTERED_API_KEY` in `.env`, then open
http://127.0.0.1:4173. Click **Build app**. Edit `app/main.jsx` and `app/style.css`
in OpenCode, then build again. **Run** executes a command in the same environment.
The app remembers its environment ID in `.vibes/environment.json` across restarts.
Copy that ID to reconnect from another SDK client. **New workspace** creates a
separate environment without deleting the old one.

Internet is enabled by default. Change `putered.sdk.config.json` to restrict
destinations or disable it; restart Vibes after changing configuration. Offline
environments cannot download missing dependencies. This config governs execution
on the Putered server, not a web page’s browser network requests.

The repository example installs the SDK from
[GitHub](https://github.com/EwanJordaan/putered-sdk). Git installs run the package
`prepare` script to compile the TypeScript sources. The downloadable starter
package includes a vendored SDK archive.

The preview runs in an iframe without same-origin access to the workbench.
Keep the workbench bound to localhost; it is a development tool, not a hosted service.
