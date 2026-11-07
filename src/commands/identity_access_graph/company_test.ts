import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backbone, CHUNK_SIZE, chunkCount, employee, employeeChunk } from './company.ts';
import { loadProfile, readBundledProfile } from './profile.ts';
import { DEPARTMENTS } from '../org_data/data/departments.ts';
import { hasEntitySource } from './documents.ts';
import { NODE_TYPES } from './triples.ts';

const base = readBundledProfile('default') as Record<string, unknown>;
const profile = (employees: number, over: Record<string, unknown> = {}) =>
  loadProfile({ ...base, ...over }, { employees, seed: 42 });
const DEPTS: string[] = DEPARTMENTS.map((d) => d.name);

test('employee i is the same whether built alone or in its chunk', () => {
  const p = profile(9000);
  const alone = employee(p, 7802);
  const inChunk = employeeChunk(p, 7).filter((n) => n.slot === 7802);
  assert.deepEqual(inChunk, alone.nodes);
  assert.deepEqual(employee(p, 7802), alone);
  const other = loadProfile(base, { employees: 9000, seed: 43 });
  assert.notDeepEqual(employee(other, 7802).nodes, alone.nodes);
});

test('chunks are fixed at 1,000 employees and cover everyone once', () => {
  const p = profile(2500);
  assert.equal(CHUNK_SIZE, 1000);
  assert.equal(chunkCount(p), 3);
  const slots = new Set<number>();
  for (let c = 0; c < chunkCount(p); c++) {
    for (const n of employeeChunk(p, c)) if (n.type === 'okta_user') slots.add(n.slot as number);
  }
  assert.equal(slots.size, 2500);
  assert.deepEqual([Math.min(...slots), Math.max(...slots)], [0, 2499]);
});

test('an employee: one Okta user and one AD account sharing the email, in a department', () => {
  const e = employee(profile(1000), 12);
  const okta = e.nodes.filter((n) => n.type === 'okta_user');
  const daily = e.nodes.filter((n) => n.type === 'ad_acct' && n.email);
  assert.equal(okta.length, 1);
  assert.equal(daily.length, 1);
  assert.equal(okta[0].email, daily[0].email);
  assert.match(okta[0].email ?? '', /^[a-z]+\.[a-z]+\.12@acme-s42\.com$/);
  assert.ok(DEPTS.includes(e.department));
  for (const n of e.nodes) assert.equal(n.department, e.department);
});

test('rates come out right across the company (fractions drawn per employee)', () => {
  const p = profile(4000);
  const all = [0, 1, 2, 3].flatMap((c) => employeeChunk(p, c));
  const count = (pred: (n: (typeof all)[number]) => boolean) => all.filter(pred).length;
  assert.equal(
    count((n) => n.type === 'okta_user'),
    4000,
  );
  const near = (got: number, want: number) =>
    assert.ok(Math.abs(got - want) < want * 0.15 + 5, `got ${got}, want ~${want}`);
  near(
    count((n) => n.type === 'ad_acct' && !n.email),
    4000 * 0.05,
  );
  near(
    count((n) => n.type === 'host'),
    4000 * 0.13,
  );
  near(
    count((n) => n.type === 'local_acct'),
    4000 * 0.2,
  );
});

test('every local account sits on a host that exists', () => {
  const p = profile(3000);
  const all = [0, 1, 2].flatMap((c) => employeeChunk(p, c));
  const hosts = new Set(all.filter((n) => n.type === 'host').map((n) => n.host?.id));
  const locals = all.filter((n) => n.type === 'local_acct');
  assert.ok(locals.length > 0);
  for (const l of locals) assert.ok(hosts.has(l.host?.id), l.entityId);
});

test('hosts have a tier: 0 (domain controllers), 1 (servers) or 2 (workstations)', () => {
  const p = profile(4000);
  const hosts = [0, 1, 2, 3].flatMap((c) => employeeChunk(p, c)).filter((n) => n.type === 'host');
  const tiers = new Set(hosts.map((h) => h.tier));
  assert.deepEqual([...tiers].sort(), [0, 1, 2]);
});

test('the backbone: built-in names always exist, the rest scale with employees', () => {
  const b = backbone(profile(1000));
  for (const name of [
    '@Everyone',
    '@Domain Users',
    '@Domain Admins',
    '@Domain Computers',
    '@Enterprise Admins',
    '@okta:Operations',
    '@ad:Product & Engineering',
  ]) {
    assert.ok(b.byName.get(name), name);
  }
  const of = (t: string) => b.nodes.filter((n) => n.type === t).length;
  assert.equal(of('role'), 50);
  assert.equal(of('bucket'), 30);
  assert.equal(of('okta_group'), 80);
  assert.ok(
    b.nodes.filter((n) => n.type === 'role').every((n) => DEPTS.includes(n.department ?? '')),
  );
  assert.deepEqual(backbone(profile(1000)), b);
});

test('every node id in the company is unique', () => {
  const p = profile(3000);
  const ids = [...backbone(p).nodes, ...[0, 1, 2].flatMap((c) => employeeChunk(p, c))].map(
    (n) => n.entityId,
  );
  assert.equal(new Set(ids).size, ids.length);
});

test('Okta users and AD accounts are one per employee at most', () => {
  const p = profile(100, { per_employee: { okta_user: 2 } });
  assert.throws(() => backbone(p), /per_employee\.okta_user: at most 1/);
});

test('every node type has an entity.source, so any per_employee type can be built', () => {
  for (const type of NODE_TYPES) assert.ok(hasEntitySource(type), type);
});
