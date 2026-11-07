import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awsAccountId,
  edgeKind,
  entityId,
  graphVersion,
  hostUuid,
  nodeName,
  seededDomain,
} from './ids.ts';
import { NODE_TYPES } from './triples.ts';

test('the seed goes into the company domain', () => {
  assert.equal(seededDomain('acme.com', 42), 'acme-s42.com');
  assert.equal(seededDomain('partner.co.uk', 7), 'partner-s7.co.uk');
});

test('the seed is the AWS account id, 12 digits', () => {
  assert.equal(awsAccountId(42), '000000000042');
  assert.throws(() => awsAccountId(10 ** 12), /seed/);
});

test('entity ids carry the seed, so runs never overlap', () => {
  const cases: Array<[Parameters<typeof entityId>[0], string]> = [
    [{ type: 'okta_user', name: 'alice', email: 'alice@acme.com' }, 'user:alice@acme-s42.com@okta'],
    [{ type: 'okta_group', name: 'eng-oncall' }, 'group:eng-oncall@acme-s42.com@okta'],
    [{ type: 'role', name: 'OncallRole' }, 'arn:aws:iam::000000000042:role/OncallRole'],
    [{ type: 'bucket', name: 'customer-data' }, 'arn:aws:s3:::customer-data-s42'],
    [
      { type: 'ad_group', name: 'Domain Admins' },
      'group:Domain Admins@acme-s42.com@active_directory',
    ],
    [{ type: 'saas', name: 'GitHub Enterprise' }, 'okta:app:GitHub Enterprise@acme-s42.com'],
    [
      { type: 'secret', name: 'prod/warehouse-admin' },
      'arn:aws:secretsmanager:us-east-1:000000000042:secret:prod/warehouse-admin',
    ],
    [
      { type: 'db', name: 'acme-warehouse' },
      'arn:aws:redshift:us-east-1:000000000042:cluster:acme-warehouse',
    ],
  ];
  for (const [node, expected] of cases) {
    assert.equal(entityId(node, 42), expected, node.type);
  }
});

test('an Okta user needs an email: its id is built from it', () => {
  assert.throws(() => entityId({ type: 'okta_user', name: 'alice' }, 42), /okta_user.*email/);
});

test('every node type has an id rule', () => {
  for (const type of NODE_TYPES) {
    const id = entityId({ type, name: 'x', email: 'x@acme.com', hostId: 'h' }, 42);
    assert.ok(id.length > 0, type);
  }
});

test('a host id is a UUID derived from (seed, name), like an agent id', () => {
  const id = hostUuid('alice-mbp', 42);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(hostUuid('alice-mbp', 42), id);
  assert.notEqual(hostUuid('alice-mbp', 43), id);
  assert.notEqual(hostUuid('bob-pc', 42), id);
  assert.equal(entityId({ type: 'host', name: 'alice-mbp' }, 42), `host:${id}`);
});

test("a local account's id names its host's UUID", () => {
  const host = hostUuid('alice-mbp', 42);
  assert.equal(
    entityId({ type: 'local_acct', name: 'alice', hostId: host }, 42),
    `user:alice@${host}@local`,
  );
  assert.throws(() => entityId({ type: 'local_acct', name: 'alice' }, 42), /local_acct.*host/);
});

test('AD accounts: by seeded email, or by name with the seed when there is no email', () => {
  assert.equal(
    entityId({ type: 'ad_acct', name: 'alice', email: 'alice@acme.com' }, 42),
    'user:alice@acme-s42.com@active_directory',
  );
  assert.equal(
    entityId({ type: 'ad_acct', name: 'da-alice' }, 42),
    'user:da-alice-s42@active_directory',
  );
  assert.equal(nodeName({ type: 'ad_acct', name: 'da-alice' }, 42), 'da-alice-s42');
  assert.equal(nodeName({ type: 'ad_acct', name: 'alice', email: 'a@acme.com' }, 42), 'alice');
});

test('edge kinds: snake_case, two reused Kibana kinds, logons split at 4', () => {
  assert.equal(edgeKind('member of'), 'member_of');
  assert.equal(edgeKind('SSO to role'), 'sso_to_role');
  assert.equal(edgeKind('owns'), 'owns');
  assert.equal(edgeKind('resolved to'), 'resolution.resolved_to');
  assert.equal(edgeKind('logs on', 12), 'accesses_frequently');
  assert.equal(edgeKind('logs on', 5), 'accesses_frequently');
  assert.equal(edgeKind('logs on', 4), 'accesses_infrequently');
  assert.equal(edgeKind('logs on'), 'accesses_infrequently');
});

test('graph_version: current only for edges Kibana builds today', () => {
  assert.equal(graphVersion('built'), 'current');
  for (const status of ['raw', 'live', 'gap'] as const) {
    assert.equal(graphVersion(status), 'future');
  }
});

test('an EC2 instance id is i- plus 17 hex digits, derived from (seed, name)', () => {
  const id = entityId({ type: 'compute', name: 'etl-server-01' }, 42);
  assert.match(id, /^arn:aws:ec2:us-east-1:000000000042:instance\/i-[0-9a-f]{17}$/);
  assert.equal(entityId({ type: 'compute', name: 'etl-server-01' }, 42), id);
  assert.notEqual(entityId({ type: 'compute', name: 'etl-server-01' }, 43), id);
});

test('IAM users, external accounts and repos carry the seed too', () => {
  assert.equal(
    entityId({ type: 'iam_user', name: 'svc-backup' }, 42),
    'user:arn:aws:iam::000000000042:user/svc-backup@aws',
  );
  const ext = entityId({ type: 'ext_acct', name: 'Datadog' }, 42);
  assert.match(ext, /^aws:account:\d{12}$/);
  assert.notEqual(entityId({ type: 'ext_acct', name: 'Datadog' }, 43), ext);
  assert.notEqual(ext, 'aws:account:000000000042', 'an external account is not ours');
  assert.equal(
    entityId({ type: 'repo', name: 'deploy-tools' }, 42),
    'github:repo:acme-s42/deploy-tools',
  );
});

test('a KMS key id is a UUID from (seed, name), in the run account', () => {
  const id = entityId({ type: 'key', name: 'pii-key' }, 42);
  assert.match(
    id,
    /^arn:aws:kms:us-east-1:000000000042:key\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.notEqual(entityId({ type: 'key', name: 'other-key' }, 42), id);
});

test('GitHub, IAM group, access point and Lambda ids carry the seed', () => {
  assert.equal(entityId({ type: 'gh_user', name: 'octo-dev' }, 42), 'user:octo-dev-s42@github');
  assert.equal(nodeName({ type: 'gh_user', name: 'octo-dev' }, 42), 'octo-dev-s42');
  assert.equal(
    entityId({ type: 'gh_team', name: 'data-eng' }, 42),
    'group:data-eng@acme-s42.com@github',
  );
  assert.equal(
    entityId({ type: 'iam_group', name: 'etl-writers' }, 42),
    'group:etl-writers@acme-s42.com@aws',
  );
  assert.equal(
    entityId({ type: 'ap', name: 'analytics-ap' }, 42),
    'arn:aws:s3:us-east-1:000000000042:accesspoint/analytics-ap',
  );
  assert.equal(
    entityId({ type: 'compute', name: 'nightly-export', service: 'lambda' }, 42),
    'arn:aws:lambda:us-east-1:000000000042:function:nightly-export',
  );
  assert.match(entityId({ type: 'compute', name: 'etl-server-01' }, 42), /:instance\/i-/);
});
