import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyGenerator } from './edges.ts';
import { pathologiesReferenced } from './pathologies.ts';
import { loadProfile, readBundledProfile } from './profile.ts';
import { type CompanyNode } from './company.ts';
import { type EdgeDoc } from './scenario.ts';

const NOW = new Date('2026-11-05T00:00:00.000Z');
const base = readBundledProfile('default') as Record<string, unknown>;
const ALL_ON = {
  hub_past_cap: { on: true, members: 1500 },
  single_choke_link: { on: true, share_cut: 0.7 },
  msol_bypass: { on: true },
  indirect_role_chain: { on: true, depth: 2 },
  breakglass_role: { on: true },
  false_merge: { on: true },
};
const build = (pathologies: object, employees = 2000) => {
  const g = companyGenerator(
    // No random edge rows: the tests check the planted structure, not paths the noise adds.
    loadProfile({ ...base, pathologies, edges: [] }, { employees, seed: 42 }),
    NOW,
  );
  const nodes: CompanyNode[] = [...g.backbone.nodes];
  const edges: EdgeDoc[] = [...g.backboneEdges];
  for (let c = 0; c < g.chunks; c++) {
    const x = g.chunk(c);
    nodes.push(...x.nodes);
    edges.push(...x.edges);
  }
  const ref = (name: string) => {
    const n = g.backbone.byName.get(name);
    assert.ok(n, `no ${name}`);
    return n;
  };
  return { g, nodes, edges, ref, byId: new Map(nodes.map((n) => [n.entityId, n])) };
};
const into = (edges: EdgeDoc[], dst: string, kind: string) =>
  edges.filter((e) => e.dst === dst && e.kind === kind);

/** Breadth-first reach over stored edges, optionally avoiding one node. */
const reaches = (edges: EdgeDoc[], from: string, to: string, avoid?: string) => {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.src, [...(out.get(e.src) ?? []), e.dst]);
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const d of out.get(id) ?? []) {
        if (d === avoid || seen.has(d)) continue;
        if (d === to) return true;
        seen.add(d);
        next.push(d);
      }
    }
    frontier = next;
  }
  return false;
};

const all = build(ALL_ON);

test('off means not planted: no pathology nodes at all', () => {
  const none = build({});
  for (const name of [
    '@All Staff',
    '@da-choke',
    '@MSOL_',
    '@chain-oncall',
    '@BreakGlassAccountRole',
  ]) {
    assert.equal(none.g.backbone.byName.get(name), undefined, name);
  }
});

test('1 hub past cap: a group with `members` company users, stored on the member side', () => {
  const members = into(all.edges, all.ref('@All Staff').entityId, 'member_of');
  assert.equal(members.length, 1500);
  assert.ok(members.every((e) => all.byId.get(e.src)?.type === 'okta_user'));
});

test('2 single choke link: 14 of 20 path users reach Domain Admins only through da-choke', () => {
  const da = all.ref('@Domain Admins').entityId;
  const choke = all.ref('@da-choke').entityId;
  assert.equal(all.ref('@Domain Admins').criticality, 'extreme_impact');
  const helpdesk = into(all.edges, all.ref('@Helpdesk').entityId, 'member_of').map((e) => e.src);
  assert.equal(helpdesk.length, 14);
  for (const u of helpdesk) {
    assert.ok(reaches(all.edges, u, da), `${u} should reach Domain Admins`);
    assert.ok(!reaches(all.edges, u, da, choke), `${u} should need da-choke`);
  }
});

test('3 MSOL_ bypass: the other 6 reach Domain Admins without da-choke, by replication', () => {
  const da = all.ref('@Domain Admins').entityId;
  const msol = all.ref('@MSOL_');
  assert.match(msol.name, /^MSOL_[0-9a-f]{12}-s42$/);
  assert.equal(into(all.edges, da, 'can_replicate')[0]?.src, msol.entityId);
  const aadc = into(all.edges, all.ref('@AADC Admins').entityId, 'member_of').map((e) => e.src);
  assert.equal(aadc.length, 6);
  const choke = all.ref('@da-choke').entityId;
  for (const u of aadc) assert.ok(reaches(all.edges, u, da, choke), u);
});

test('4 indirect role chain: chain-oncall members reach the vault through `depth` assumes', () => {
  const vault = all.ref('@customer-pii-vault');
  assert.equal(vault.criticality, 'extreme_impact');
  const members = into(all.edges, all.ref('@chain-oncall').entityId, 'member_of');
  assert.equal(members.length, 30);
  const assumes = all.edges.filter(
    (e) => e.kind === 'can_assume' && all.byId.get(e.src)?.name.startsWith('ChainRole-'),
  );
  assert.equal(assumes.length, 2);
  for (const m of members.slice(0, 5)) assert.ok(reaches(all.edges, m.src, vault.entityId), m.src);
  // No policy names the role the members get directly: only the end of the chain reads the vault.
  const direct = all.edges.filter((e) => e.kind === 'bucket_policy' && e.dst === vault.entityId);
  assert.ok(direct.every((e) => all.byId.get(e.src)?.name !== 'ChainRole-0'));
});

test('6 break-glass role: a few company roles can assume it, and it reads the vault', () => {
  const bg = all.ref('@BreakGlassAccountRole').entityId;
  const callers = into(all.edges, bg, 'can_assume');
  assert.equal(callers.length, 3);
  assert.ok(callers.every((e) => all.byId.get(e.src)?.type === 'role'));
  assert.ok(
    all.edges.some(
      (e) =>
        e.src === bg &&
        e.kind === 'bucket_policy' &&
        e.dst === all.ref('@customer-pii-vault').entityId,
    ),
  );
});

test("13 false merge: an AWS session identity with an employee's email, never resolved", () => {
  const session = all.nodes.find(
    (n) => n.type === 'iam_user' && n.name.startsWith('assumed-role/'),
  );
  assert.ok(session?.email, 'the session carries an email');
  assert.ok(all.nodes.some((n) => n.type === 'okta_user' && n.email === session?.email));
  assert.equal(all.edges.filter((e) => e.src === session?.entityId).length, 0);
});

test('every planted edge is a real triple with its version and source', () => {
  const planted = all.edges.filter((e) =>
    /choke|MSOL_|aadc|AADC|Helpdesk|Chain|chain|BreakGlass|All Staff|vault/.test(e.src + e.dst),
  );
  assert.ok(planted.length > 50);
  for (const e of planted) {
    assert.ok(e.graph_version === 'current' || e.graph_version === 'future', JSON.stringify(e));
    assert.ok(e.source.length > 0);
  }
});

test('a scenario that references a pathology node switches that pathology on', () => {
  const scenario = {
    edges: [
      ['alice', 'member of', '@chain-oncall'],
      ['x', 'can assume', '@BreakGlassAccountRole'],
      ['y', 'member of', '@Everyone'],
    ],
  };
  assert.deepEqual(pathologiesReferenced(scenario).sort(), [
    'breakglass_role',
    'indirect_role_chain',
  ]);
});
