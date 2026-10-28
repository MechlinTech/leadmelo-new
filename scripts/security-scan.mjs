import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'coverage', 'test-results', 'playwright-report']);
const DROPPER_NAMES = ['temp_auto_push.bat', 'temp_interactive_push.bat', 'branch_structure.json'];
const ROOT_DROPPERS = ['init', 'api.js'];
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
const PAYLOAD_MARKER = 'global.i = ' + "'A10-";
const EVAL_CALL = 'ev' + 'al(';
const ATOB_CALL = 'at' + 'ob(';
const MAX_BYTES = 5_000_000;

export function scanRoot(root, options = {}) {
  const findings = [];
  const packagePath = path.join(root, 'package.json');
  if (fs.existsSync(packagePath)) findings.push(...scanPackage(packagePath));
  const lockPath = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockPath)) findings.push(...scanLockfile(lockPath));
  const ignorePath = path.join(root, '.gitignore');
  if (fs.existsSync(ignorePath)) findings.push(...scanIgnore(ignorePath));
  if (!options.packageOnly) findings.push(...scanTree(root));
  return findings;
}

function scanPackage(packagePath) {
  const findings = [];
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch {
    return [`${packagePath}: package.json is not valid JSON`];
  }
  const scripts = pkg.scripts ?? {};
  for (const name of LIFECYCLE) {
    if (scripts[name]) findings.push(`${packagePath}: lifecycle script "${name}" is not allowed`);
  }
  for (const [name, command] of Object.entries(scripts)) {
    const text = String(command);
    if (/\bnode\s+(?:init|api\.js)\b/.test(text) || DROPPER_NAMES.some(dropper => text.includes(dropper))) {
      findings.push(`${packagePath}: script "${name}" launches a known dropper`);
    }
  }
  return findings;
}

function scanLockfile(lockPath) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return [`${lockPath}: package-lock.json is not valid JSON`];
  }
  const findings = [];
  for (const [name, meta] of Object.entries(lock.packages ?? {})) {
    const resolved = meta?.resolved;
    if (typeof resolved !== 'string') continue;
    if (!resolved.startsWith('https://registry.npmjs.org/')) {
      findings.push(`${lockPath}: ${name || 'root'} resolves outside the npm registry (${resolved})`);
    }
  }
  return findings;
}

function scanIgnore(ignorePath) {
  const findings = [];
  const lines = fs.readFileSync(ignorePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const bare = trimmed.replace(/^\//, '');
    if (DROPPER_NAMES.includes(bare) || ROOT_DROPPERS.includes(bare)) {
      findings.push(`${ignorePath}: ignore rule hides ${bare}`);
    }
  }
  return findings;
}

function scanTree(root) {
  const findings = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (DROPPER_NAMES.includes(entry.name) || (ROOT_DROPPERS.includes(entry.name) && path.dirname(rel) === '.')) {
        findings.push(`${rel}: known dropper filename`);
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_BYTES) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      if (text.includes(PAYLOAD_MARKER)) findings.push(`${rel}: obfuscated loader marker`);
      for (const line of text.split(/\r?\n/)) {
        if (line.includes(ATOB_CALL) && line.includes(EVAL_CALL)) {
          findings.push(`${rel}: decoded eval loader`);
          break;
        }
      }
    }
  }
  return findings;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath.toLowerCase() === modulePath.toLowerCase()) {
  const findings = scanRoot(process.cwd(), { packageOnly: process.argv.includes('--package-only') });
  if (findings.length) {
    console.error(findings.join('\n'));
    process.exit(1);
  }
  console.log('security scan: no known droppers');
}
