import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenario, readBundledScenario } from './scenario.ts';

const NOW = new Date('2026-11-05T00:00:00.000Z');
const opts = { seed: 42, now: NOW };

const base = {
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

const withEdges = (edges: unknown[]) => ({ ...base, edges });

test('local ids become entity ids, and edges become edge documents', () => {
  const s = loadScenario(base, opts);
  assert.deepEqual(
    s.nodes.map((n) => n.entityId),
    [
      'user:alice@acme-s42.com@okta',
      'group:eng-oncall@acme-s42.com@okta',
      'arn:aws:iam::000000000042:role/OncallRole',
      'arn:aws:s3:::customer-data-s42',
    ],
  );
  assert.deepEqual(s.edges[0], {
    src: 'user:alice@acme-s42.com@okta',
    kind: 'member_of',
    dst: 'group:eng-oncall@acme-s42.com@okta',
    graph_version: 'future',
    source: 'okta-ea',
    first_seen: NOW.toISOString(),
    last_seen: NOW.toISOString(),
  });
  assert.equal(s.edges.length, 3);
});

test('node fields carry through: email, criticality, blind_spot', () => {
  const s = loadScenario(base, opts);
  assert.equal(s.nodes[0].email, 'alice@acme-s42.com');
  assert.equal(s.nodes[3].criticality, 'extreme_impact');
  assert.equal(s.nodes[3].blindSpot, false);
});

test('an impossible edge fails the load, naming the triple', () => {
  assert.throws(
    () => loadScenario(withEdges([['alice', 'can assume', 'bucket']]), opts),
    /impossible edge: okta_user -\[can assume\]-> bucket/,
  );
});

test('an edge to an unknown local id fails', () => {
  assert.throws(
    () => loadScenario(withEdges([['alice', 'member of', 'nobody']]), opts),
    /unknown node "nobody"/,
  );
});

test('duplicate local ids fail', () => {
  const dup = { ...base, nodes: [...base.nodes, { id: 'alice', type: 'okta_group', name: 'x' }] };
  assert.throws(() => loadScenario(dup, opts), /duplicate node id "alice"/);
});

test('an unknown node type fails', () => {
  const bad = { ...base, nodes: [{ id: 'x', type: 'printer', name: 'p' }], edges: [] };
  assert.throws(() => loadScenario(bad, opts), /unknown node type "printer"/);
});

test('an unknown criticality level fails', () => {
  const bad = { ...base, nodes: [{ ...base.nodes[3], criticality: 'very' }], edges: [] };
  assert.throws(() => loadScenario(bad, opts), /criticality "very"/);
});

test('loaded alone, edges to @ company nodes are skipped and reported', () => {
  const s = loadScenario(withEdges([['alice', 'member of', '@Everyone'], ...base.edges]), opts);
  assert.equal(s.edges.length, 3);
  assert.deepEqual(s.skipped, ['alice -[member of]-> @Everyone']);
});

test('last_seen is relative to the run time; first_seen defaults to last_seen', () => {
  const s = loadScenario(withEdges([['alice', 'member of', 'oncall', { last_seen: '-3d' }]]), opts);
  assert.equal(s.edges[0].last_seen, '2026-11-02T00:00:00.000Z');
  assert.equal(s.edges[0].first_seen, '2026-11-02T00:00:00.000Z');
});

test('first_seen after last_seen fails', () => {
  assert.throws(
    () =>
      loadScenario(
        withEdges([['alice', 'member of', 'oncall', { first_seen: '-1d', last_seen: '-3d' }]]),
        opts,
      ),
    /first_seen after last_seen/,
  );
});

test('logons is only for logs on; unknown edge options fail', () => {
  assert.throws(
    () => loadScenario(withEdges([['alice', 'member of', 'oncall', { logons: 3 }]]), opts),
    /logons.*only for "logs on"/,
  );
  assert.throws(
    () => loadScenario(withEdges([['alice', 'member of', 'oncall', { when: '-1d' }]]), opts),
    /unknown edge option "when"/,
  );
});

test('the bundled stolen-okta-session scenario is example 1, graph part', () => {
  const s = loadScenario(readBundledScenario('stolen-okta-session'), opts);
  assert.equal(s.name, 'stolen-okta-session');
  assert.equal(s.nodes.length, 18);
  assert.equal(s.edges.length, 19);
  assert.deepEqual(s.skipped, []);
  const jewels = s.nodes.filter((n) => n.criticality).map((n) => n.name);
  assert.deepEqual(jewels.sort(), ['Domain Admins', 'acme-customer-pii', 'acme-warehouse']);
  const kinds = new Set(s.edges.map((e) => e.kind));
  for (const k of [
    'resolution.resolved_to',
    'owns',
    'accesses_frequently',
    'can_assume',
    'same_machine',
    'credentials_left',
    'holds_its_password',
  ]) {
    assert.ok(kinds.has(k), k);
  }
  assert.ok(s.description.length > 0);
});

const company = {
  name: 'hosts',
  description: 'Alice logs on to her laptop; her admin account has no email.',
  nodes: [
    { id: 'local_alice', type: 'local_acct', name: 'alice', host: 'laptop' },
    { id: 'laptop', type: 'host', name: 'alice-mbp' },
    { id: 'server', type: 'host', name: 'db-01' },
    { id: 'da', type: 'ad_acct', name: 'da-alice' },
  ],
  edges: [['local_alice', 'logs on', 'laptop', { logons: 12 }]],
};

test('a local account takes its id from its host, wherever the host is listed', () => {
  const s = loadScenario(company, opts);
  const laptop = s.nodes.find((n) => n.localId === 'laptop');
  const local = s.nodes.find((n) => n.localId === 'local_alice');
  assert.equal(local?.entityId, `user:alice@${laptop?.host?.id}@local`);
  assert.deepEqual(local?.host, laptop?.host);
  assert.equal(laptop?.host?.name, 'alice-mbp');
});

test('logs on: frequently above 4 logons, built today, source defend', () => {
  const [e] = loadScenario(company, opts).edges;
  assert.equal(e.kind, 'accesses_frequently');
  assert.equal(e.graph_version, 'current');
  assert.equal(e.source, 'defend');
});

test('a local account logs on only to its own host', () => {
  const bad = { ...company, edges: [['local_alice', 'logs on', 'server']] };
  assert.throws(() => loadScenario(bad, opts), /logs on.*its own host "laptop"/);
});

test('the host field: required on local accounts, must name a host, only on local accounts', () => {
  const withNode = (node: object) => ({
    ...company,
    nodes: [...company.nodes.slice(1), node],
    edges: [],
  });
  assert.throws(
    () => loadScenario(withNode({ id: 'x', type: 'local_acct', name: 'x' }), opts),
    /node "x": a local_acct needs "host"/,
  );
  assert.throws(
    () => loadScenario(withNode({ id: 'x', type: 'local_acct', name: 'x', host: 'da' }), opts),
    /node "x": host "da" is not a host node/,
  );
  assert.throws(
    () => loadScenario(withNode({ id: 'x', type: 'ad_acct', name: 'x', host: 'laptop' }), opts),
    /node "x": only a local_acct has a host/,
  );
});

test('an AD account without email carries the seed in its name', () => {
  const da = loadScenario(company, opts).nodes.find((n) => n.localId === 'da');
  assert.equal(da?.name, 'da-alice-s42');
  assert.equal(da?.entityId, 'user:da-alice-s42@active_directory');
});

const companyNames = new Map([
  ['@Everyone', { entityId: 'group:Everyone@acme-s42.com@okta', type: 'okta_group' as const }],
  [
    '@Domain Users',
    { entityId: 'group:Domain Users@acme-s42.com@active_directory', type: 'ad_group' as const },
  ],
]);

test('planted, an @ edge resolves to the company node', () => {
  const s = loadScenario(withEdges([['alice', 'member of', '@Everyone'], ...base.edges]), {
    ...opts,
    company: companyNames,
  });
  assert.deepEqual(s.skipped, []);
  assert.equal(s.edges.length, 4);
  assert.equal(s.edges[0].dst, 'group:Everyone@acme-s42.com@okta');
  assert.equal(s.edges[0].kind, 'member_of');
});

test('planted, an @ edge still has to be a real triple', () => {
  assert.throws(
    () =>
      loadScenario(withEdges([['alice', 'member of', '@Domain Users']]), {
        ...opts,
        company: companyNames,
      }),
    /impossible edge: okta_user -\[member of\]-> ad_group/,
  );
});

test('planted, an unknown @ name fails and lists the names there are', () => {
  assert.throws(
    () =>
      loadScenario(withEdges([['alice', 'member of', '@Nobody']]), {
        ...opts,
        company: companyNames,
      }),
    /"@Nobody" is not a company name \(there are: @Everyone, @Domain Users\)/,
  );
});

test('planted, a company node can only be an edge target', () => {
  assert.throws(
    () =>
      loadScenario(withEdges([['@Everyone', 'SSO to role', 'r_oncall']]), {
        ...opts,
        company: companyNames,
      }),
    /a company node \(@Everyone\) can only be an edge target/,
  );
});

test('a company node as an edge source fails alone too, not only when planted', () => {
  assert.throws(
    () => loadScenario(withEdges([['@Everyone', 'SSO to role', 'r_oncall']]), opts),
    /a company node \(@Everyone\) can only be an edge target/,
  );
});
