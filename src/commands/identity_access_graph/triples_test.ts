import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIPLES, findTriple } from './triples.ts';

test('the copy of model.js keeps all 37 rows, role_entry merged into role', () => {
  assert.equal(TRIPLES.length, 37);
  assert.ok(findTriple('role', 'can assume', 'role'));
  assert.ok(findTriple('okta_group', 'SSO to role', 'role'));
});

test('exactly three kinds are built by the Entity Store today', () => {
  const built = TRIPLES.filter((x) => x.status === 'built').map(
    (x) => `${x.from} ${x.kind} ${x.to}`,
  );
  assert.deepEqual(built, [
    'local_acct logs on host',
    'local_acct resolved to ad_acct',
    'okta_user resolved to ad_acct',
  ]);
});

test('no triple appears twice, and every one names a source dataset', () => {
  const keys = TRIPLES.map((x) => `${x.from}|${x.kind}|${x.to}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const x of TRIPLES) assert.ok(x.sources.length > 0, `${x.from} ${x.kind} ${x.to}`);
});
