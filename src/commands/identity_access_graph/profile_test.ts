import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSize, estimateSize, loadProfile, readBundledProfile } from './profile.ts';

const TINY = {
  seed: 1,
  employees: 1000,
  per_employee: { okta_user: 1, okta_group: 0.1, role: 0.05 },
  edges: [
    {
      triple: ['okta_user', 'member of', 'okta_group'],
      per_source: { dist: 'uniform', min: 1, max: 3 },
      targets: [{ fixed: '@Everyone' }, { same: 'department' }, { random: true, skew: 1.2 }],
      source: 'guess',
    },
    {
      triple: ['okta_group', 'SSO to role', 'role'],
      per_source: { dist: 'uniform', min: 1, max: 1, zero: 0.8 },
      targets: [{ random: true }],
      source: 'guess',
    },
  ],
  logon_count: { dist: 'lognormal', median: 3, p99: 40 },
  arrays_cap: 1000,
  pathologies: { single_choke_link: { on: true, share_cut: 0.7 }, msol_bypass: { on: false } },
  blind_spots: { host: 0.1 },
};
const withRow = (row: object) => ({ ...TINY, edges: [...TINY.edges, row] });
const row = (over: object) => ({
  triple: ['role', 'can assume', 'role'],
  per_source: { dist: 'uniform', min: 1, max: 1 },
  targets: [{ random: true }],
  source: 'guess',
  ...over,
});

test('the bundled default profile loads', () => {
  const p = loadProfile(readBundledProfile('default'));
  assert.ok(p.employees > 0);
  assert.ok(p.edges.length > 0);
  assert.equal(p.arraysCap, 1000);
});

test('CLI overrides employees and seed; nothing else', () => {
  const p = loadProfile(TINY, { employees: 50000, seed: 7 });
  assert.equal(p.employees, 50000);
  assert.equal(p.seed, 7);
  assert.equal(loadProfile(TINY).employees, 1000);
});

test('the profile is checked against the triples list', () => {
  assert.throws(
    () => loadProfile(withRow(row({ triple: ['okta_user', 'can assume', 'bucket'] }))),
    /edges\[2\]: impossible triple okta_user -\[can assume\]-> bucket/,
  );
});

test('unknown node types, pathologies and bad shares fail', () => {
  assert.throws(
    () => loadProfile({ ...TINY, per_employee: { printer: 1 } }),
    /per_employee: unknown node type "printer"/,
  );
  assert.throws(
    () => loadProfile({ ...TINY, pathologies: { teleport: { on: true } } }),
    /pathologies: unknown pathology "teleport"/,
  );
  assert.throws(
    () => loadProfile({ ...TINY, pathologies: { single_choke_link: { on: true, depth: 2 } } }),
    /pathologies\.single_choke_link: unknown knob "depth"/,
  );
  assert.throws(
    () => loadProfile({ ...TINY, blind_spots: { host: 1.5 } }),
    /blind_spots\.host: must be from 0 to 1/,
  );
  assert.throws(() => loadProfile({ ...TINY, arrays_cap: -1 }), /arrays_cap/);
  assert.throws(() => loadProfile({ ...TINY, employees: 0 }), /employees/);
});

test('pickers: five kinds, each with its own shape', () => {
  const bad: Array<[object, RegExp]> = [
    [{ teleport: 1 }, /unknown picker/],
    [{ same: 'shoe size' }, /same: "shoe size" is not one of department, tier/],
    [{ random: 2 }, /random: must be true \(it fills what the draw leaves\)/],
    [{ random: true, skew: -1 }, /skew: 0 or more/],
    [{ fixed: 'Everyone' }, /fixed: an @ name/],
    [{ own: false }, /own: must be true/],
  ];
  for (const [picker, re] of bad) {
    assert.throws(() => loadProfile(withRow(row({ targets: [picker] }))), re);
  }
});

test('random fills what is left, so it must be the last picker', () => {
  assert.throws(
    () => loadProfile(withRow(row({ targets: [{ random: true }, { same: 'department' }] }))),
    /edges\[2\]\.targets: random must be the last picker/,
  );
});

test('via follows real triples and must end at the row target type', () => {
  const ok = row({
    triple: ['role', 'decrypt', 'key'],
    targets: [
      {
        via: [
          ['bucket policy', 'bucket'],
          ['encrypted with', 'key'],
        ],
      },
    ],
  });
  const bucketRow = row({ triple: ['role', 'bucket policy', 'bucket'] });
  const keyRow = row({ triple: ['bucket', 'encrypted with', 'key'] });
  const p = loadProfile({ ...TINY, edges: [ok, bucketRow, keyRow] });
  // Rows that a via row follows come first.
  assert.deepEqual(
    p.edges.map((e) => e.kind),
    ['bucket policy', 'encrypted with', 'decrypt'],
  );
  assert.throws(
    () =>
      loadProfile(
        withRow(
          row({
            triple: ['role', 'decrypt', 'key'],
            targets: [{ via: [['bucket policy', 'bucket']] }],
          }),
        ),
      ),
    /via ends at bucket, not key/,
  );
  assert.throws(
    () =>
      loadProfile(
        withRow(
          row({ triple: ['role', 'decrypt', 'key'], targets: [{ via: [['decrypt', 'bucket']] }] }),
        ),
      ),
    /via step role -\[decrypt\]-> bucket is not a triple/,
  );
});

test('a via cycle fails the profile at load', () => {
  // Two rows that each follow the other's edges.
  const policy = row({
    triple: ['role', 'bucket policy', 'bucket'],
    targets: [{ via: [['role policy', 'bucket']] }],
  });
  const rolePolicy = row({
    triple: ['role', 'role policy', 'bucket'],
    targets: [{ via: [['bucket policy', 'bucket']] }],
  });
  assert.throws(
    () => loadProfile({ ...TINY, edges: [policy, rolePolicy] }),
    /via cycle: role -\[bucket policy\]-> bucket .*role -\[role policy\]-> bucket/,
  );
});

test('a row may only appear once per triple', () => {
  assert.throws(
    () => loadProfile({ ...TINY, edges: [...TINY.edges, TINY.edges[0]] }),
    /edges\[2\]: okta_user -\[member of\]-> okta_group appears twice/,
  );
});

test('size estimate: employees x ratios, edges from mean out-degree', () => {
  const est = estimateSize(loadProfile(TINY));
  // 1000 users + 100 groups + 50 roles
  assert.equal(est.nodes, 1150);
  // 1000 users x 2 groups + 100 groups x 0.2 x 1 role
  assert.equal(est.edges, 2020);
});

test('guardrail: refuses above the limit, with the message the spec gives', () => {
  const big = loadProfile(TINY, { employees: 53_000_000 });
  assert.throws(
    () => checkSize(estimateSize(big), 50_000_000),
    /^Error: Estimated 61M nodes, 107M edges\. Limit is 50M nodes; pass --max-nodes 70000000 to run anyway\.$/,
  );
  assert.doesNotThrow(() => checkSize(estimateSize(big), 70_000_000));
});

test('arrays_cap defaults to 1,000 when the profile leaves it out', () => {
  const { arrays_cap: _, ...rest } = TINY;
  assert.equal(loadProfile(rest).arraysCap, 1000);
});

test('crown jewels and hub grants: each field is checked at load', () => {
  const grant = {
    from: '@Domain Users',
    kind: 'local admin',
    to: 'host',
    tier: 2,
    share: 0.5,
    source: 'guess',
  };
  const p = loadProfile({
    ...TINY,
    crown_jewels: { names: ['@Domain Admins'], per_type: { bucket: 20 } },
    hub_grants: [grant],
  });
  assert.deepEqual(p.crownJewels, { names: ['@Domain Admins'], perType: { bucket: 20 } });
  assert.deepEqual(p.hubGrants, [grant]);
  assert.deepEqual(loadProfile(TINY).crownJewels, { names: [], perType: {} });
  assert.deepEqual(loadProfile(TINY).hubGrants, []);

  const bad: Array<[object, RegExp]> = [
    [{ crown_jewels: { names: ['Domain Admins'] } }, /crown_jewels\.names: a list of @ names/],
    [{ crown_jewels: { per_type: { host: 5 } } }, /"host" is not a shared node type/],
    [{ crown_jewels: { per_type: { bucket: 1.5 } } }, /crown_jewels\.per_type\.bucket/],
    [{ crown_jewels: { size: 50 } }, /crown_jewels: unknown field "size"/],
    [
      { hub_grants: [{ ...grant, kind: 'can assume' }] },
      /no triple has kind "can assume" ending at host/,
    ],
    [{ hub_grants: [{ ...grant, to: 'bucket', kind: 'bucket policy' }] }, /tier: hosts only/],
    [{ hub_grants: [{ ...grant, tier: 3 }] }, /tier: hosts only/],
    [{ hub_grants: [{ ...grant, share: 2 }] }, /share: must be from 0 to 1/],
    [{ hub_grants: [{ ...grant, source: '' }] }, /source: say where the share comes from/],
  ];
  for (const [over, re] of bad) assert.throws(() => loadProfile({ ...TINY, ...over }), re);
});

test('size estimate counts hub grant edges: the share of target nodes, by tier for hosts', () => {
  const withHosts = { ...TINY, per_employee: { ...TINY.per_employee, host: 0.1 } };
  const without = estimateSize(loadProfile(withHosts)).edges;
  const grant = {
    from: '@Domain Users',
    kind: 'local admin',
    to: 'host',
    share: 0.5,
    source: 'guess',
  };
  // 1000 employees x 0.1 hosts x 0.85 workstations x 0.5
  const workstations = loadProfile({ ...withHosts, hub_grants: [{ ...grant, tier: 2 }] });
  assert.equal(estimateSize(workstations).edges - without, 43);
});

test('scale-target: the bundled profile for 5M nodes and 100M edges', () => {
  const est = estimateSize(loadProfile(readBundledProfile('scale-target')));
  assert.ok(Math.abs(est.nodes - 5e6) < 5e6 * 0.02, `nodes: ${est.nodes}`);
  assert.ok(Math.abs(est.edges - 1e8) < 1e8 * 0.05, `edges: ${est.edges}`);
});

test('a bundled profile that does not exist names the ones that do', () => {
  assert.throws(() => readBundledProfile('huge'), /no bundled profile "huge" \(bundled: .*default/);
});
