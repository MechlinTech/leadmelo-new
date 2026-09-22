import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// SHA-256 of every git-tracked file (except this manifest). Run before packaging; the archive is
// built from tracked files only, so node_modules, build output and .env files are never included.
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(f => f && f !== 'RELEASE_FILE_HASHES.json');
const manifest = Object.fromEntries(files.map(f => [f, createHash('sha256').update(readFileSync(f)).digest('hex')]));
writeFileSync('RELEASE_FILE_HASHES.json', JSON.stringify({ generatedFrom: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), files: manifest }, null, 1) + '\n');
console.log(`${files.length} files hashed`);
