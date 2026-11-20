// Mini-tools factory (mini-tools.yml): screenshots of a static Next.js export without a dev server.
// Serves <outDir> on a free localhost port (clean URLs: /x -> x.html or x/index.html), captures each path with
// headless Chrome, then stops the server. No npm dependencies.
//   node minitools/screenshots.mjs <outDir> <destDir> [--mobile] [--dark] <path> [<path> ...]
// Files: <destDir>/<name>.png where name comes from the path ("/" -> home), plus "-mobile" / "-dark" suffixes.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Async on purpose: a blocking spawnSync would stop this process's own HTTP server from answering Chrome.
const run = (cmd, argv, ms) => new Promise((resolve) => {
  const p = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  const t = setTimeout(() => p.kill(), ms);
  p.on('close', (status) => { clearTimeout(t); resolve({ status, stderr: err }); });
});

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [outDir, destDir, ...paths] = args.filter((a) => !a.startsWith('--'));
if (!outDir || !destDir || !paths.length) {
  console.error('Usage: node minitools/screenshots.mjs <outDir> <destDir> [--mobile] [--dark] <path> [...]');
  process.exit(2);
}
const root = path.resolve(outDir);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const candidates = [url, `${url}.html`, path.join(url, 'index.html')].map((p) => path.join(root, p));
  const file = candidates.find((f) => f.startsWith(root) && fs.existsSync(f) && fs.statSync(f).isFile());
  if (!file) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
if (!chrome) { console.error('No Chrome found (set CHROME_PATH)'); process.exit(1); }
fs.mkdirSync(destDir, { recursive: true });
const size = flags.has('--mobile') ? '390,844' : '1440,900';
const suffix = `${flags.has('--mobile') ? '-mobile' : ''}${flags.has('--dark') ? '-dark' : ''}`;
let failed = 0;
for (const p of paths) {
  const name = (p.replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-') || 'home') + suffix;
  const file = path.resolve(destDir, `${name}.png`);
  const r = await run(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', ...(process.env.CI ? ['--no-sandbox'] : []),
    ...(flags.has('--dark') ? ['--force-dark-mode'] : []), // prefers-color-scheme: dark (the app's own dark theme)
    `--window-size=${size}`, '--virtual-time-budget=5000', `--screenshot=${file}`, `http://127.0.0.1:${port}${p.startsWith('/') ? p : `/${p}`}`,
  ], 60000);
  if (r.status === 0 && fs.existsSync(file)) console.log(`ok ${path.relative(process.cwd(), file)}`);
  else { failed++; console.log(`FAILED ${p}: ${(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || r.status}`); }
}
server.close();
process.exit(failed ? 1 : 0);
