import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { buildDocuments, relationshipsCopy } from './documents.ts';
import { loadScenario, type EdgeDoc } from './scenario.ts';

const NOW = new Date('2026-11-05T00:00:00.000Z');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const TINY = {
  name: 'tiny',
  description: 'Alice reaches the bucket.',
  nodes: [
    { id: 'alice', type: 'okta_user', name: 'alice', email: 'alice@acme.com' },
    { id: 'oncall', type: 'okta_group', name: 'eng-oncall' },
    { id: 'r_oncall', type: 'role', name: 'OncallRole' },
    { id: 'bucket', type: 'bucket', name: 'customer-data', criticality: 'extreme_impact' },
  ],
  edges: [
    ['alice', 'member of', 'oncall'],
    ['oncall', 'SSO to role', 'r_oncall'],
    ['r_oncall', 'bucket policy', 'bucket'],
  ],
};
const loaded = loadScenario(TINY, { seed: 42, now: NOW });
const docs = buildDocuments(loaded, { seed: 42, now: NOW, arraysCap: 1000 });
const node = (id: string) => {
  const n = docs.nodes.find((x) => x.doc.entity.id === id);
  assert.ok(n, `no node ${id}`);
  return n;
};

test('node _id is sha256(entity.id), Kibana rule', () => {
  const alice = node('user:alice@acme-s42.com@okta');
  assert.equal(alice._id, sha256('user:alice@acme-s42.com@okta'));
});

test('an Okta user is written the way Kibana writes one', () => {
  const { doc } = node('user:alice@acme-s42.com@okta');
  assert.equal(doc['@timestamp'], NOW.toISOString());
  assert.deepEqual(doc.entity.EngineMetadata, {
    Type: 'user',
    UntypedId: 'alice@acme-s42.com@okta',
  });
  assert.equal(doc.entity.type, 'Identity');
  assert.equal(doc.entity.sub_type, 'okta_user');
  assert.equal(doc.entity.namespace, 'okta');
  assert.equal(doc.entity.name, 'alice');
  assert.equal(doc.entity.source, 'entityanalytics_okta');
  assert.deepEqual(doc.entity.lifecycle, {
    first_seen: NOW.toISOString(),
    last_seen: NOW.toISOString(),
  });
  assert.deepEqual(doc.user, { name: 'alice', email: 'alice@acme-s42.com' });
  assert.deepEqual(doc.labels, { identity_graph_seed: '42' });
});

test('generic nodes: display type, id as-is, no namespace', () => {
  const group = node('group:eng-oncall@acme-s42.com@okta').doc;
  assert.equal(group.entity.type, 'Group');
  assert.equal(group.entity.EngineMetadata.Type, 'generic');
  assert.equal(group.entity.EngineMetadata.UntypedId, 'group:eng-oncall@acme-s42.com@okta');
  assert.equal(group.entity.namespace, undefined);
  const role = node('arn:aws:iam::000000000042:role/OncallRole').doc;
  assert.equal(role.entity.type, 'Access Management');
  assert.equal(role.entity.source, 'cloud_asset_inventory.asset_inventory');
  assert.equal(node('arn:aws:s3:::customer-data-s42').doc.entity.type, 'Storage Bucket');
});

test('crown jewels get asset.criticality', () => {
  assert.deepEqual(node('arn:aws:s3:::customer-data-s42').doc.asset, {
    criticality: 'extreme_impact',
  });
  assert.equal(node('user:alice@acme-s42.com@okta').doc.asset, undefined);
});

test('the arrays copy sits on the source entity, in attack direction', () => {
  assert.deepEqual(node('user:alice@acme-s42.com@okta').doc.entity.relationships, {
    member_of: { ids: ['group:eng-oncall@acme-s42.com@okta'] },
  });
  assert.deepEqual(node('group:eng-oncall@acme-s42.com@okta').doc.entity.relationships, {
    sso_to_role: { ids: ['arn:aws:iam::000000000042:role/OncallRole'] },
  });
  assert.equal(node('arn:aws:s3:::customer-data-s42').doc.entity.relationships, undefined);
});

test('edge _id is sha256(src|kind|dst|source); docs carry the seed label', () => {
  const e = docs.edges[0];
  assert.equal(
    e._id,
    sha256('user:alice@acme-s42.com@okta|member_of|group:eng-oncall@acme-s42.com@okta|okta-ea'),
  );
  assert.deepEqual(e.doc.labels, { identity_graph_seed: '42' });
  assert.equal(e.doc.graph_version, 'future');
  assert.equal(docs.edges.length, 3);
});

const edge = (dst: string, kind = 'member_of'): EdgeDoc => ({
  src: 'a',
  kind,
  dst,
  graph_version: 'future',
  source: 'x',
  first_seen: NOW.toISOString(),
  last_seen: NOW.toISOString(),
});

test('the copy is capped per kind, and a capped kind is listed', () => {
  const copy = relationshipsCopy([edge('g1'), edge('g2'), edge('g3'), edge('r1', 'can_assume')], 2);
  assert.deepEqual(copy.get('a'), {
    relationships: { member_of: { ids: ['g1', 'g2'] }, can_assume: { ids: ['r1'] } },
    truncated: ['member_of'],
  });
});

test('arrays_cap 0 writes no copy at all', () => {
  assert.equal(relationshipsCopy([edge('g1')], 0).size, 0);
});

test('resolved_to is a single value, as Kibana stores it', () => {
  const copy = relationshipsCopy([edge('ad-alice', 'resolution.resolved_to')], 1000);
  assert.deepEqual(copy.get('a')?.relationships, { resolution: { resolved_to: 'ad-alice' } });
});

test('a truncated node carries labels.identity_graph_truncated_kinds', () => {
  const many = {
    ...loaded,
    edges: [loaded.edges[0], { ...loaded.edges[0], dst: loaded.nodes[1].entityId + 'x' }],
  };
  const d = buildDocuments(many, { seed: 42, now: NOW, arraysCap: 1 });
  const alice = d.nodes.find((x) => x.doc.entity.id === 'user:alice@acme-s42.com@okta');
  assert.deepEqual(alice?.doc.labels, {
    identity_graph_seed: '42',
    identity_graph_truncated_kinds: ['member_of'],
  });
  assert.deepEqual(d.truncatedDocs, { member_of: 1 });
});

test('blind-spot nodes are refused until the writer supports them', () => {
  const blind = { ...loaded, nodes: loaded.nodes.map((n, i) => ({ ...n, blindSpot: i === 0 })) };
  assert.throws(
    () => buildDocuments(blind, { seed: 42, now: NOW, arraysCap: 1000 }),
    /blind_spot.*not supported yet/,
  );
});

test('hosts and local accounts are written the way Kibana writes them', () => {
  const g = loadScenario(
    {
      name: 'h',
      description: 'd',
      nodes: [
        { id: 'laptop', type: 'host', name: 'alice-mbp' },
        { id: 'local_alice', type: 'local_acct', name: 'alice', host: 'laptop' },
      ],
      edges: [['local_alice', 'logs on', 'laptop', { logons: 12 }]],
    },
    { seed: 42, now: NOW },
  );
  const d = buildDocuments(g, { seed: 42, now: NOW, arraysCap: 1000 });
  const [host, local] = d.nodes.map((n) => n.doc);
  const uuid = g.nodes[0].host?.id ?? '';
  assert.equal(host.entity.id, `host:${uuid}`);
  assert.deepEqual(host.entity.EngineMetadata, { Type: 'host', UntypedId: uuid });
  assert.deepEqual(host.host, { id: uuid, name: 'alice-mbp' });
  assert.equal(host.entity.name, 'alice-mbp');
  assert.equal(host.entity.source, 'endpoint');

  assert.equal(local.entity.name, 'alice@alice-mbp');
  assert.equal(local.entity.namespace, 'local');
  assert.deepEqual(local.user, { name: 'alice' });
  assert.deepEqual(local.host, { id: uuid });
  assert.deepEqual(local.entity.relationships, { accesses_frequently: { ids: [host.entity.id] } });
});

test('GitHub nodes get the stand-in source github; a Lambda is FaaS', () => {
  const g = loadScenario(
    {
      name: 'gh',
      description: 'd',
      nodes: [
        { id: 'dev', type: 'gh_user', name: 'octo-dev' },
        { id: 'team', type: 'gh_team', name: 'data-eng' },
        { id: 'fn', type: 'compute', name: 'nightly-export', service: 'lambda' },
        { id: 'vm', type: 'compute', name: 'etl-server-01' },
      ],
      edges: [['dev', 'member of', 'team']],
    },
    { seed: 42, now: NOW },
  );
  const d = buildDocuments(g, { seed: 42, now: NOW, arraysCap: 1000 });
  const [dev, team, fn, vm] = d.nodes.map((n) => n.doc);
  assert.equal(dev.entity.source, 'github');
  assert.equal(dev.entity.namespace, 'github');
  assert.equal(dev.entity.type, 'Identity');
  assert.equal(team.entity.source, 'github');
  assert.equal(team.entity.type, 'Group');
  assert.equal(fn.entity.type, 'FaaS');
  assert.equal(vm.entity.type, 'Virtual Machine');
});
