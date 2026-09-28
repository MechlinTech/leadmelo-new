import http from 'node:http';
import { spawn } from 'node:child_process';

// Next 15 + React 19 strips <link rel="stylesheet"> from the App Router layout,
// and the production build table has no CSS chunk. Serve Next on 3001 and inject
// /leadmelo.css into HTML on the public port so both SSR and first paint are styled.
const UP_PORT = 3001;
const LISTEN = Number(process.env.PORT || 3000);
const LINK = '<link rel="stylesheet" href="/leadmelo.css">';

const child = spawn('npm', ['start'], {
  env: { ...process.env, PORT: String(UP_PORT), HOSTNAME: '127.0.0.1' },
  stdio: 'inherit'
});
child.on('exit', (code) => process.exit(code ?? 1));

function inject(html) {
  if (html.includes('leadmelo.css')) return html;
  if (html.includes('</head>')) return html.replace('</head>', `${LINK}</head>`);
  return `${LINK}${html}`;
}

function listen() {
  http.createServer((req, res) => {
    const p = http.request({
      hostname: '127.0.0.1',
      port: UP_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${UP_PORT}` }
    }, (pres) => {
      const ct = String(pres.headers['content-type'] || '');
      if (!ct.includes('text/html')) {
        res.writeHead(pres.statusCode || 502, pres.headers);
        pres.pipe(res);
        return;
      }
      const chunks = [];
      pres.on('data', (c) => chunks.push(c));
      pres.on('end', () => {
        const html = inject(Buffer.concat(chunks).toString('utf8'));
        const headers = { ...pres.headers, 'content-length': String(Buffer.byteLength(html)) };
        delete headers['transfer-encoding'];
        res.writeHead(pres.statusCode || 200, headers);
        res.end(html);
      });
    });
    p.on('error', () => {
      res.statusCode = 502;
      res.end('upstream unavailable');
    });
    req.pipe(p);
  }).listen(LISTEN, '0.0.0.0', () => {
    console.log(`css-inject proxy listening on ${LISTEN} -> ${UP_PORT}`);
  });
}

function waitUp(tries = 0) {
  const req = http.get({ hostname: '127.0.0.1', port: UP_PORT, path: '/api/health' }, (r) => {
    r.resume();
    listen();
  });
  req.on('error', () => {
    if (tries > 90) process.exit(1);
    setTimeout(() => waitUp(tries + 1), 1000);
  });
}

setTimeout(() => waitUp(), 400);
