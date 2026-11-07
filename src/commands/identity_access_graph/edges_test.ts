import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyGenerator } from './edges.ts';
import { loadProfile, readBundledProfile, estimateSize } from './profile.ts';
import { type CompanyNode } from './company.ts';

const NOW = new Date('2026-11-05T00:00:00.000Z');
const base = readBundledProfile('default') as Record<string, unknown>;
const row = (triple: string[], per_source: object, targets: object[]) => ({
  triple,
  per_source,
  targets,
  source: 'test',
});
// Pathologies off: these tests check picker mechanics; pathologies_test.ts checks planting.
const gen = (edges: object[], employees = 2000, over: Record<string, unknown> = {}) =>
  companyGenerator(
    loadProfile({ ...base, pathologies: {}, ...over, edges }, { employees, seed: 42 }),
    NOW,
  );
const allChunks = (g: ReturnType<typeof gen>) => {
  const nodes: CompanyNode[] = [...g.backbone.nodes];
  const edges = [...g.backboneEdges];
  for (let c = 0; c < g.chunks; c++) {
    const x = g.chunk(c);
    nodes.push(...x.nodes);
    edges.push(...x.edges);
  }
  return { nodes, edges, byId: new Map(nodes.map((n) => [n.entityId, n])) };
};

test('pickers fill the draw in order: Everyone, the department group, then random', () => {
  const g = gen([
    row(['okta_user', 'member of', 'okta_group'], { dist: 'uniform', min: 5, max: 5 }, [
      { fixed: '@Everyone' },
      { same: 'department' },
      { random: true },
    ]),
  ]);
  const { nodes, edges, byId } = allChunks(g);
  const everyone = g.backbone.byName.get('@Everyone')?.entityId;
  for (const user of nodes.filter((n) => n.type === 'okta_user').slice(0, 50)) {
    const mine = edges.filter((e) => e.src === user.entityId && e.kind === 'member_of');
    assert.equal(mine.length, 5, user.entityId);
    assert.equal(mine[0].dst, everyone);
    assert.equal(byId.get(mine[1].dst)?.department, user.department);
    assert.equal(new Set(mine.map((e) => e.dst)).size, 5, 'no duplicate targets');
  }
});

test('the last picker takes what the draw leaves', () => {
  const g = gen([
    row(['ad_group', 'local admin', 'host'], { dist: 'uniform', min: 20, max: 20 }, [
      { same: 'tier' },
    ]),
  ]);
  const { nodes, edges, byId } = allChunks(g);
  const admins = g.backbone.nodes.filter((n) => n.type === 'ad_group' && n.tier !== undefined);
  assert.ok(admins.length > 0);
  const hostsOfTier = (t: number | undefined) =>
    nodes.filter((n) => n.type === 'host' && n.tier === t).length;
  for (const grp of admins) {
    const mine = edges.filter((e) => e.src === grp.entityId);
    assert.equal(mine.length, Math.min(20, hostsOfTier(grp.tier)), grp.name);
    for (const e of mine) assert.equal(byId.get(e.dst)?.tier, grp.tier);
  }
  // Groups without a tier have nothing to match.
  const plain = g.backbone.nodes.find((n) => n.type === 'ad_group' && n.tier === undefined);
  assert.equal(edges.filter((e) => e.src === plain?.entityId).length, 0);
});

test('own: a local account logs on to its own host, split by logon count', () => {
  const g = gen([
    row(['local_acct', 'logs on', 'host'], { dist: 'uniform', min: 1, max: 1 }, [{ own: true }]),
  ]);
  const { nodes, edges: all } = allChunks(g);
  const edges = all.filter((e) => e.kind.startsWith('accesses_'));
  const locals = nodes.filter((n) => n.type === 'local_acct');
  assert.equal(edges.length, locals.length);
  for (const l of locals) {
    const e = edges.find((x) => x.src === l.entityId);
    assert.equal(e?.dst, `host:${l.host?.id}`);
  }
  const kinds = new Set(edges.map((e) => e.kind));
  assert.deepEqual([...kinds].sort(), ['accesses_frequently', 'accesses_infrequently']);
  assert.ok(edges.every((e) => e.graph_version === 'current' && e.source === 'defend'));
});

test('via: a role decrypts only keys of buckets it reaches', () => {
  const g = gen(
    [
      row(['role', 'bucket policy', 'bucket'], { dist: 'uniform', min: 2, max: 2 }, [
        { random: true },
      ]),
      row(['bucket', 'encrypted with', 'key'], { dist: 'uniform', min: 1, max: 1 }, [
        { random: true },
      ]),
      row(['role', 'decrypt', 'key'], { dist: 'uniform', min: 5, max: 5 }, [
        {
          via: [
            ['bucket policy', 'bucket'],
            ['encrypted with', 'key'],
          ],
        },
      ]),
    ],
    3000,
  );
  const { edges } = allChunks(g);
  const out = (src: string, kind: string) =>
    edges.filter((e) => e.src === src && e.kind === kind).map((e) => e.dst);
  let decrypts = 0;
  for (const role of g.backbone.nodes.filter((n) => n.type === 'role')) {
    const reachable = new Set(
      out(role.entityId, 'bucket_policy').flatMap((b) => out(b, 'encrypted_with')),
    );
    for (const k of out(role.entityId, 'decrypt')) {
      assert.ok(reachable.has(k), `${role.name} decrypts ${k} without reaching its bucket`);
      decrypts++;
    }
  }
  assert.ok(decrypts > 0);
});

test('targets owned by employees are found by index: credentials left on hosts', () => {
  const g = gen([
    row(['host', 'credentials left', 'ad_acct'], { dist: 'uniform', min: 2, max: 2 }, [
      { random: true, skew: 1 },
    ]),
  ]);
  const { edges, byId } = allChunks(g);
  assert.ok(edges.length > 0);
  for (const e of edges) assert.equal(byId.get(e.dst)?.type, 'ad_acct', e.dst);
});

test('skew makes a few targets popular', () => {
  const share = (skew: number) => {
    const g = gen([
      row(['okta_user', 'member of', 'okta_group'], { dist: 'uniform', min: 1, max: 1 }, [
        { random: true, skew },
      ]),
    ]);
    const { edges } = allChunks(g);
    const counts = new Map<string, number>();
    for (const e of edges) counts.set(e.dst, (counts.get(e.dst) ?? 0) + 1);
    const top = [...counts.values()].sort((a, b) => b - a).slice(0, 16);
    return top.reduce((a, b) => a + b, 0) / edges.length;
  };
  assert.ok(share(2) > share(0) * 2, `skew 2 ${share(2)} vs skew 0 ${share(0)}`);
});

test('edges are the same however the run is chunked: each source draws from its own stream', () => {
  const g1 = gen(base.edges as object[]);
  const g2 = gen(base.edges as object[]);
  assert.deepEqual(g1.chunk(1).edges, g2.chunk(1).edges);
  assert.deepEqual(g1.backboneEdges, g2.backboneEdges);
});

test('the default profile lands near its estimate', () => {
  const p = loadProfile(base, { employees: 2000, seed: 42 });
  const g = companyGenerator(p, NOW);
  const { nodes, edges } = allChunks(g);
  const est = estimateSize(p);
  const near = (got: number, want: number, what: string) =>
    assert.ok(Math.abs(got - want) < want * 0.25, `${what}: got ${got}, estimated ${want}`);
  near(nodes.length, est.nodes, 'nodes');
  near(edges.length, est.edges, 'edges');
});

test('profile rows that cannot work with this company fail up front', () => {
  assert.throws(
    () =>
      gen([
        row(['okta_user', 'member of', 'okta_group'], { dist: 'uniform', min: 1, max: 1 }, [
          { fixed: '@Nobody' },
        ]),
      ]),
    /edges okta_user -\[member of\]-> okta_group: fixed "@Nobody" is not a company name/,
  );
  assert.throws(
    () =>
      gen([
        row(['okta_user', 'member of', 'okta_group'], { dist: 'uniform', min: 1, max: 1 }, [
          { fixed: '@Domain Users' },
        ]),
      ]),
    /fixed "@Domain Users" is an ad_group, not an okta_group/,
  );
  assert.throws(
    () =>
      gen([
        row(['role', 'can assume', 'role'], { dist: 'uniform', min: 1, max: 1 }, [{ own: true }]),
      ]),
    /own: a role has no own role/,
  );
});

test("resolution: each Okta user resolves to the AD account with the same email, as Kibana's rule does", () => {
  const g = gen([]);
  const { nodes, edges, byId } = allChunks(g);
  const resolved = edges.filter((e) => e.kind === 'resolution.resolved_to');
  const okta = nodes.filter((n) => n.type === 'okta_user');
  assert.equal(resolved.length, okta.length);
  for (const e of resolved) {
    const from = byId.get(e.src);
    const to = byId.get(e.dst);
    assert.equal(from?.type, 'okta_user');
    assert.equal(to?.type, 'ad_acct');
    assert.equal(from?.email, to?.email);
    assert.equal(e.graph_version, 'current');
    assert.equal(e.source, 'entity-store');
  }
  // Admin accounts have no email, so nothing resolves to them.
  const admins = new Set(
    nodes.filter((n) => n.type === 'ad_acct' && !n.email).map((n) => n.entityId),
  );
  assert.ok(admins.size > 0);
  assert.ok(resolved.every((e) => !admins.has(e.dst)));
});
