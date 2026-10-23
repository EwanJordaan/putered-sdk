import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Putered } from '@putered/sdk';

const project = fileURLToPath(new URL('./', import.meta.url));
const previewNames = new Set(['index.html', 'main.js', 'main.css']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export function createVibesServer({ client, directory = project } = {}) {
  const state = join(directory, '.vibes');
  let environment, environmentId, busy = false;
  const sdk = () => { if (!client) throw new Error('Set PUTERED_BASE_URL and PUTERED_API_KEY in .env, then restart Vibes.'); return client; };
  async function storedId() {
    if (environmentId) return environmentId;
    try { environmentId = JSON.parse(await readFile(join(state, 'environment.json'), 'utf8')).id; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .vibes/environment.json. Restore it or rename it to start fresh.'); }
    return environmentId;
  }
  async function connect(id, fresh = false) {
    const current = id || (!fresh && await storedId());
    environment = current ? await sdk().environments.connect(current) : await sdk().environments.create();
    environmentId = environment.id;
    await mkdir(state, { recursive: true });
    await writeFile(join(state, 'environment.tmp'), JSON.stringify({ id: environmentId }) + '\n', { mode: 0o600 });
    await rename(join(state, 'environment.tmp'), join(state, 'environment.json'));
    return environment;
  }
  const current = () => environment ? Promise.resolve(environment) : connect();
  return createServer(async (req, res) => {
    const send = (status, value, type = 'application/json') => {
      if (res.destroyed) return;
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    const port = res.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return send(403, { error: 'Use the localhost Vibes URL.' });
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    let accepted = false;
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.method === 'GET' && path === '/') {
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        return send(200, await readFile(join(directory, 'public/index.html')), types['.html']);
      }
      if (req.method === 'GET' && path === '/api/status') {
        let previewReady = false;
        try { await readFile(join(state, 'preview/index.html')); previewReady = true; } catch {}
        return send(200, { configured: !!client, id: await storedId() ?? null, previewReady });
      }
      if (req.method === 'GET' && path.startsWith('/preview/')) {
        const name = path.slice('/preview/'.length);
        if (!previewNames.has(name)) return send(404, { error: 'Not found.' });
        const suffix = '.' + name.split('.').at(-1);
        return send(200, await readFile(join(state, 'preview', name)), types[suffix]);
      }
      if (req.method !== 'POST' || !['/api/connect', '/api/run', '/api/build'].includes(path)) return send(404, { error: 'Not found.' });
      if (!hosts.some(host => req.headers.origin === `http://${host}`)) return send(403, { error: 'Use the Vibes page to run commands.' });
      if (busy) return send(409, { error: 'A command is running. Wait for it to finish.' });
      busy = true; accepted = true;
      let text = '';
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw new Error('Request is too large.'); }
      const input = JSON.parse(text || '{}');
      if (path === '/api/connect') {
        const env = await connect(input.id, input.fresh === true);
        return send(200, { id: env.id });
      }
      const env = await current();
      if (path === '/api/run') return send(200, await env.exec(input.command, { timeoutMs: 300000, signal: controller.signal }));
      const files = {};
      for (const name of ['index.html', 'main.jsx', 'style.css']) files[name] = await readFile(join(directory, 'app', name), 'utf8');
      files['package.json'] = JSON.stringify({ private: true, dependencies: { react: '19.2.0', 'react-dom': '19.2.0', esbuild: '0.25.12' } });
      const payload = Buffer.from(JSON.stringify(files)).toString('base64');
      const command = `mkdir -p /workspace/vibes && cd /workspace/vibes && node -e 'const fs=require("fs");for(const [name,text] of Object.entries(JSON.parse(Buffer.from("${payload}","base64"))))fs.writeFileSync(name,text)' && npm install --no-audit --no-fund && npx --no-install esbuild main.jsx --bundle --minify --outdir=dist && cp index.html dist/index.html`;
      const result = await env.exec(command, { timeoutMs: 300000, signal: controller.signal });
      if (result.exitCode !== 0) return send(200, { ...result, previewReady: false });
      const read = await env.exec(`cd /workspace/vibes && node -e 'const fs=require("fs");const out={};for(const name of ["index.html","main.js","main.css"])out[name]=fs.readFileSync("dist/"+name,"utf8");process.stdout.write(JSON.stringify(out))'`, { timeoutMs: 30000, signal: controller.signal });
      if (read.exitCode !== 0) return send(200, { ...read, previewReady: false });
      const built = JSON.parse(read.stdout);
      await mkdir(join(state, 'preview'), { recursive: true });
      for (const name of previewNames) await writeFile(join(state, 'preview', name), built[name]);
      return send(200, { ...result, previewReady: true, id: env.id });
    } catch (error) { send(error.code === 'ENOENT' ? 404 : 400, { error: error.message || 'The request failed.' }); }
    finally { if (accepted) busy = false; }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let client;
  if (process.env.PUTERED_BASE_URL && process.env.PUTERED_API_KEY)
    client = new Putered({ baseUrl: process.env.PUTERED_BASE_URL, apiKey: process.env.PUTERED_API_KEY });
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createVibesServer({ client });
  server.listen(port, '127.0.0.1', () => console.log(`Vibes → http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => process.exit(0)); server.closeAllConnections(); });
}
