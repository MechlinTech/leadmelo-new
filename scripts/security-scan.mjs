#!/usr/bin/env node
// Repository integrity guard.
//
// This check exists because the repository has previously shipped an obfuscated
// loader in api.js, a second copy hidden in postcss.config.mjs, and a third copy
// disguised as a font file. It deliberately fails closed on the exact indicators
// observed in those incidents, plus a few structural rules that make a repeat
// unlikely to go unnoticed.
//
// Usage: node scripts/security-scan.mjs   (also runs in CI before npm ci)

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

const files = trackedFiles().filter(file => existsSync(path.join(root, file)));

// --- 1. Known-bad filenames -------------------------------------------------
const forbiddenNames = new Set([
  'api.js',
  'temp_auto_push.bat',
  'temp_interactive_push.bat',
  'branch_structure.json',
]);
for (const file of files) {
  const base = path.posix.basename(file.replaceAll('\\', '/')).toLowerCase();
  if (forbiddenNames.has(base)) fail(`forbidden file present: ${file}`);
  const normalized = file.replaceAll('\\', '/').toLowerCase();
  if (normalized === '.vscode/tasks.json') fail(`unexpected automatic task file: ${file}`);
}

// --- 2. Secrets must never be tracked --------------------------------------
for (const file of files) {
  const normalized = file.replaceAll('\\', '/');
  if (/(^|\/)\.env($|\.)/.test(normalized) && normalized !== '.env.example') {
    fail(`environment file must not be tracked: ${file}`);
  }
}

// --- 3. High-confidence payload indicators ---------------------------------
const payloadSignatures = [
  'Z2xvYmFs',
  "global.i = 'A10-",
  'A10-**',
  'q4FZkxX',
  '_0x9710a8',
  '0x1eEf0849EDa15d87f64e51C73C8442Cf3c8bCEF3',
  'eth.blockscout.com/api',
  'X-Payload-B64',
  "global['_V']",
  'run_loader',
  'atob(_0x',
];

const textExtensions = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.yml', '.yaml',
  '.sh', '.ps1', '.bat', '.cmd', '.py', '.sql', '.prisma', '.md', '.html',
  '.css', '.svg', '.txt', '.toml',
]);

const executableExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const allowedChildProcess = [/^scripts\//, /^tests\//, /^gateway\//, /^worker\//];

for (const file of files) {
  const absolute = path.join(root, file);
  let info;
  try {
    info = statSync(absolute);
  } catch {
    continue;
  }
  if (!info.isFile()) continue;

  const normalized = file.replaceAll('\\', '/');
  const ext = path.extname(file).toLowerCase();
  const size = info.size;

  // Signature scanning works on binary-ish files too, because the previous
  // loader was stored as a text file with an .otf extension.
  if (size <= 8 * 1024 * 1024) {
    const text = readFileSync(absolute).toString('latin1');
    for (const signature of payloadSignatures) {
      if (text.includes(signature)) fail(`malware signature "${signature}" in ${file}`);
    }

    if (executableExtensions.has(ext)) {
      const source = text;
      if (/\beval\s*\(/.test(source)) fail(`eval() is not allowed in application code: ${file}`);
      if (/\bnew\s+Function\s*\(/.test(source)) fail(`new Function() is not allowed in application code: ${file}`);
      if (/\batob\s*\(/.test(source)) fail(`atob() is not allowed in application code: ${file}`);
      if (/createRequire\s*\(/.test(source) && !normalized.startsWith('scripts/')) {
        fail(`createRequire() is not allowed in application code: ${file}`);
      }
      if (/child_process/.test(source) && !allowedChildProcess.some(re => re.test(normalized))) {
        fail(`child_process is not allowed outside scripts/tests/gateway/worker: ${file}`);
      }
    }

    if (textExtensions.has(ext) && /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      fail(`private key material in ${file}`);
    }
  }

  // --- 4. Fonts must actually be fonts -------------------------------------
  if (['.woff', '.woff2', '.ttf', '.otf'].includes(ext)) {
    const head = readFileSync(absolute).subarray(0, 4);
    const magic = head.toString('hex');
    const ok =
      (ext === '.woff' && magic === '774f4646') ||
      (ext === '.woff2' && magic === '774f4632') ||
      (ext === '.ttf' && magic === '00010000') ||
      (ext === '.otf' && (magic === '4f54544f' || magic === '00010000'));
    if (!ok) fail(`file has a font extension but is not a valid font: ${file}`);
  }
  if (ext === '.svg' && normalized.includes('/fonts/')) {
    const text = readFileSync(absolute, 'latin1');
    if (/<script[\s>]/i.test(text) || /onload\s*=/i.test(text)) {
      fail(`script content inside font SVG: ${file}`);
    }
  }
}

// --- 5. Root scripts must not invoke a loader ------------------------------
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  if (/\bapi\.js\b|temp_auto_push|temp_interactive_push|branch_structure/i.test(String(command))) {
    fail(`package.json script "${name}" invokes a forbidden file: ${command}`);
  }
}

// --- 6. Lockfile integrity -------------------------------------------------
try {
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [name, entry] of Object.entries(lock.packages ?? {})) {
    if (!name) continue;
    if (entry.resolved && !entry.link && !entry.resolved.startsWith('https://registry.npmjs.org/')) {
      fail(`dependency resolves outside the npm registry: ${name} -> ${entry.resolved}`);
    }
    if (entry.resolved && !entry.integrity) {
      fail(`dependency has no integrity hash: ${name}`);
    }
  }
} catch (error) {
  fail(`could not verify package-lock.json: ${error.message}`);
}

if (failures.length) {
  console.error('Security scan failed:');
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`Security scan passed (${files.length} tracked files checked).`);
