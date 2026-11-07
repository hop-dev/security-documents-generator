// Integration test against a running stack (config.json). Run with IAG_IT=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getEsClient } from '../utils/indices.ts';
import {
  cleanIdentityAccessGraph,
  edgesIndexBody,
  generateIdentityAccessGraph,
  loadIdentityAccessScenario,
} from './writer.ts';
import { hostUuid } from './ids.ts';

const skip = process.env.IAG_IT !== '1' && 'set IAG_IT=1 to run against the stack';
const SEED = 990042;
const SPACE = 'default';
const NOW = new Date('2026-11-05T00:00:00.000Z');

const countBySeed = async (index: string) => {
  const r = await getEsClient().count({
    index,
    query: { term: { 'labels.identity_graph_seed': String(SEED) } },
  });
  return r.count;
};

test('load, refuse a second load, clean', { skip }, async () => {
  await cleanIdentityAccessGraph({ seed: SEED, space: SPACE });

  const result = await loadIdentityAccessScenario({
    scenario: 'stolen-okta-session',
    seed: SEED,
    space: SPACE,
    now: NOW,
  });
  assert.equal(result.nodes, 18);
  assert.equal(result.edges, 19);
  assert.equal(await countBySeed('entities-latest-default'), 18);
  assert.equal(await countBySeed('entities-edges-default'), 19);

  const alice = await getEsClient().get<{ entity: { relationships: unknown } }>({
    index: 'entities-latest-default',
    id: result.sampleNodeId,
  });
  assert.deepEqual(alice._source?.entity.relationships, {
    member_of: {
      ids: [
        `group:eng-oncall@acme-s${SEED}.com@okta`,
        `group:all-employees@acme-s${SEED}.com@okta`,
      ],
    },
    owns: { ids: [`user:asmith@${hostUuid('ACME-MBP-0412', SEED)}@local`] },
    resolution: { resolved_to: `user:alice@acme-s${SEED}.com@active_directory` },
  });

  // A walk's forward hop on the edges index, as the PoC would run it.
  const hop = await getEsClient().esql.query({
    query:
      'FROM entities-edges-default | WHERE src == ? AND kind == "member_of" | KEEP kind, dst | SORT dst',
    params: [`user:alice@acme-s${SEED}.com@okta`],
  });
  assert.deepEqual(hop.values, [
    ['member_of', `group:all-employees@acme-s${SEED}.com@okta`],
    ['member_of', `group:eng-oncall@acme-s${SEED}.com@okta`],
  ]);

  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'));
  assert.equal(manifest.scenario.name, 'stolen-okta-session');
  assert.equal(manifest.counts.edges.bucket_policy, 2);
  assert.equal(manifest.counts.nodes.role, 4);

  await assert.rejects(
    loadIdentityAccessScenario({
      scenario: 'stolen-okta-session',
      seed: SEED,
      space: SPACE,
      now: NOW,
    }),
    /Seed 990042 already has 18 entities in space "default"[\s\S]*clean-identity-access-graph --seed 990042/,
  );

  const cleaned = await cleanIdentityAccessGraph({ seed: SEED, space: SPACE });
  assert.deepEqual(cleaned, { nodes: 18, edges: 19 });
  assert.equal(await countBySeed('entities-latest-default'), 0);
  assert.equal(await countBySeed('entities-edges-default'), 0);
  assert.ok(existsSync(result.manifestPath), 'clean leaves the manifest');
});

test('a space without the Entity Store fails before writing', { skip }, async () => {
  await assert.rejects(
    loadIdentityAccessScenario({
      scenario: 'stolen-okta-session',
      seed: SEED,
      space: 'no-such-space',
      now: NOW,
    }),
    /Entity Store isn't installed in space "no-such-space"/,
  );
});

test('generate a company, refuse a second run, clean', { skip }, async () => {
  const seed = 990044;
  await cleanIdentityAccessGraph({ seed, space: SPACE });
  const r = await generateIdentityAccessGraph({ employees: 1500, seed, space: SPACE, now: NOW });
  const count = (index: string) =>
    getEsClient()
      .count({ index, query: { term: { 'labels.identity_graph_seed': String(seed) } } })
      .then((x) => x.count);
  assert.ok(r.nodes > 1500 && r.edges > 1500, `${r.nodes} nodes, ${r.edges} edges`);
  assert.equal(await count('entities-latest-default'), r.nodes);
  assert.equal(await count('entities-edges-default'), r.edges);

  const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf8'));
  assert.equal(manifest.command, 'generate-identity-access-graph');
  assert.equal(manifest.profile.employees, 1500);
  assert.equal(manifest.profile.seed, seed);
  assert.equal(manifest.counts.nodes.okta_user, 1500);
  assert.equal(manifest.counts.employees, 1500);
  const c = manifest.counts.nodes;
  assert.equal(
    manifest.counts.identities,
    (c.okta_user ?? 0) + (c.ad_acct ?? 0) + (c.local_acct ?? 0) + (c.iam_user ?? 0),
  );
  assert.ok(manifest.estimate.nodes > 0);

  // Every node and edge is checked: no doc without EngineMetadata.Type, edges only of known kinds.
  const noType = await getEsClient().count({
    index: 'entities-latest-default',
    query: {
      bool: {
        filter: [{ term: { 'labels.identity_graph_seed': String(seed) } }],
        must_not: [{ exists: { field: 'entity.EngineMetadata.Type' } }],
      },
    },
  });
  assert.equal(noType.count, 0);

  await assert.rejects(
    generateIdentityAccessGraph({ employees: 1500, seed, space: SPACE, now: NOW }),
    /Seed 990044 already has [\d,]+ entities in space "default"/,
  );
  const cleaned = await cleanIdentityAccessGraph({ seed, space: SPACE });
  assert.deepEqual(cleaned, { nodes: r.nodes, edges: r.edges });
});

test('the guardrail stops a run before anything is written', { skip }, async () => {
  await assert.rejects(
    generateIdentityAccessGraph({ employees: 30_000_000, seed: 990045, space: SPACE, now: NOW }),
    /Estimated \d+M nodes, .* Limit is 50M nodes; pass --max-nodes \d+ to run anyway\./,
  );
});

test('generate --scenario plants it in the company, linked by @ names', { skip }, async () => {
  const seed = 990046;
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'iag-')), 'planted.json');
  writeFileSync(
    file,
    JSON.stringify({
      name: 'planted',
      description: 'Alice is in Everyone and reaches the bucket.',
      nodes: [
        { id: 'alice', type: 'okta_user', name: 'alice', email: 'alice@acme.com' },
        { id: 'r', type: 'role', name: 'PlantedRole' },
        { id: 'b', type: 'bucket', name: 'planted-pii', criticality: 'extreme_impact' },
      ],
      edges: [
        ['alice', 'member of', '@Everyone'],
        ['alice', 'SSO to role', 'r'],
        ['r', 'bucket policy', 'b'],
      ],
    }),
  );
  await cleanIdentityAccessGraph({ seed, space: SPACE });
  const r = await generateIdentityAccessGraph({
    employees: 300,
    seed,
    space: SPACE,
    now: NOW,
    scenario: file,
  });
  const alice = `user:alice@acme-s${seed}.com@okta`;
  const everyone = `group:Everyone@acme-s${seed}.com@okta`;
  const hop = await getEsClient().esql.query({
    query: 'FROM entities-edges-default | WHERE src == ? | KEEP kind, dst | SORT kind',
    params: [alice],
  });
  assert.deepEqual(hop.values, [
    ['member_of', everyone],
    ['sso_to_role', `arn:aws:iam::000000${seed}:role/PlantedRole`],
  ]);
  const manifest = JSON.parse(readFileSync(r.manifestPath, 'utf8'));
  assert.equal(manifest.scenario.name, 'planted');
  assert.ok(manifest.counts.nodes.okta_user > 300, 'company users plus Alice');
  await cleanIdentityAccessGraph({ seed, space: SPACE });
});

test('a scenario node with a company id fails before anything is written', { skip }, async () => {
  const seed = 990047;
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'iag-')), 'clash.json');
  writeFileSync(
    file,
    JSON.stringify({
      name: 'clash',
      description: 'Defines its own Everyone group, which the company already has.',
      nodes: [{ id: 'all', type: 'okta_group', name: 'Everyone' }],
      edges: [],
    }),
  );
  await assert.rejects(
    generateIdentityAccessGraph({ employees: 100, seed, space: SPACE, now: NOW, scenario: file }),
    /scenario "clash" has a node with the same id as a generated one \(group:Everyone@acme-s990047\.com@okta\); rename it in the scenario/,
  );
  const { count } = await getEsClient().count({
    index: 'entities-latest-default',
    query: { term: { 'labels.identity_graph_seed': String(seed) } },
  });
  assert.equal(count, 0);
});

test(
  'a planted scenario that cannot be written fails before anything is written',
  { skip },
  async () => {
    const seed = 990048;
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'iag-')), 'blind.json');
    writeFileSync(
      file,
      JSON.stringify({
        name: 'blind',
        description: 'A blind-spot node, which the writer does not support yet.',
        nodes: [{ id: 'h', type: 'host', name: 'blind-host', blind_spot: true }],
        edges: [],
      }),
    );
    await assert.rejects(
      generateIdentityAccessGraph({ employees: 100, seed, space: SPACE, now: NOW, scenario: file }),
      /blind_spot is not supported yet/,
    );
    const { count } = await getEsClient().count({
      index: 'entities-latest-default',
      query: { term: { 'labels.identity_graph_seed': String(seed) } },
    });
    assert.equal(count, 0, 'nothing written');
  },
);

test('the edges index the generator creates uses replicas that fit a one-node cluster', () => {
  const body = edgesIndexBody('x');
  assert.equal(body.settings['index.mode'], 'lookup');
  assert.equal(body.settings['index.hidden'], true);
  assert.equal(body.settings['index.auto_expand_replicas'], '0-1');
});

test('a missing profile file says so, before touching Elasticsearch', async () => {
  await assert.rejects(
    generateIdentityAccessGraph({ profile: '/nonexistent/profile.json', space: SPACE, now: NOW }),
    /profile file not found: \/nonexistent\/profile\.json/,
  );
});
