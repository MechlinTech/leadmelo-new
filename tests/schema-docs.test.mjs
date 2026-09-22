import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { generate, CLASSIFICATION } from '../scripts/generate-schema-docs.mjs';

test('schema reference is current: every table is classified and the committed file matches the schema and migrations', () => {
  const generated = generate() + '\n'; // throws if a model has no classification
  const committed = readFileSync('docs/SCHEMA_REFERENCE.md', 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, generated, 'run `npm run docs:schema` and commit docs/SCHEMA_REFERENCE.md');
  const schema = readFileSync('prisma/schema.prisma', 'utf8');
  const models = [...schema.matchAll(/^model (\w+) \{/gm)].map(m => m[1]);
  assert.deepEqual(Object.keys(CLASSIFICATION).sort(), models.sort());
  for (const dir of readdirSync('prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory())) assert.ok(committed.includes(dir.name), `migration ${dir.name} listed`);
  assert.match(committed, /erDiagram/); assert.match(committed, /Invariants enforced in SQL/);
});

test('the SQL migrations really create every model\'s table (schema and SQL agree)', () => {
  const sql = readdirSync('prisma/migrations', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => readFileSync(`prisma/migrations/${d.name}/migration.sql`, 'utf8')).join('\n');
  for (const name of Object.keys(CLASSIFICATION)) assert.match(sql, new RegExp(`CREATE TABLE "${name}"`), `${name} has a CREATE TABLE in the migrations`);
});
