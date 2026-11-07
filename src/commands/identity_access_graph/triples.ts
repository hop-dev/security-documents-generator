// The edges the identity access graph allows: (source type, kind, target type).
// A one-time copy of graph-analytics docs/model.js EDGE_KINDS (elastic/security-graph,
// 2026-11-05), with role_entry merged into role. `sources` are the datasets that provide
// the edge (docs/datasets.html); the first one is written as the edge's `source`.
// This list is ours now: no sync with model.js.

export const NODE_TYPES = [
  'okta_user',
  'okta_group',
  'ad_acct',
  'ad_group',
  'local_acct',
  'host',
  'iam_user',
  'iam_group',
  'gh_user',
  'gh_team',
  'repo',
  'role',
  'bucket',
  'key',
  'secret',
  'db',
  'ap',
  'compute',
  'ext_acct',
  'saas',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/** How far Elastic is from building the edge today (model.js "status today"). */
export type Status = 'built' | 'raw' | 'live' | 'gap';

export interface Triple {
  from: NodeType;
  kind: string;
  to: NodeType;
  status: Status;
  sources: readonly string[];
}

const t = (
  from: NodeType,
  kind: string,
  to: NodeType,
  status: Status,
  sources: string[],
): Triple => ({ from, kind, to, status, sources });

export const TRIPLES: readonly Triple[] = [
  t('gh_user', 'member of', 'gh_team', 'raw', ['gh-members']),
  t('gh_team', 'can push', 'repo', 'gap', ['gh-audit', 'gh-repo']),
  t('gh_user', 'can push', 'repo', 'gap', ['gh-repo']),
  t('repo', 'OIDC trust', 'role', 'raw', ['cai']),
  t('okta_user', 'member of', 'okta_group', 'raw', ['okta-ea', 'entra-ea']),
  t('okta_group', 'SSO to role', 'role', 'gap', ['okta-apps', 'aws-sso', 'cloudtrail']),
  t('okta_user', 'SSO to role', 'role', 'gap', ['okta-apps', 'aws-sso']),
  t('okta_group', 'app assignment', 'saas', 'gap', ['okta-apps', 'okta-syslog']),
  t('ext_acct', 'external trust', 'role', 'raw', ['cai']),
  t('role', 'can assume', 'role', 'raw', ['cai', 'aws-gaad']),
  t('role', 'can read', 'secret', 'gap', ['aws-gaad', 'aws-resources']),
  t('role', 'role policy', 'db', 'gap', ['aws-gaad']),
  t('secret', 'holds its password', 'db', 'gap', ['aws-resources']),
  t('role', 'bucket policy', 'bucket', 'raw', ['cai']),
  t('role', 'role policy', 'bucket', 'gap', ['aws-gaad']),
  t('role', 'decrypt', 'key', 'gap', ['aws-gaad', 'aws-resources']),
  t('bucket', 'encrypted with', 'key', 'gap', ['cai', 'aws-resources']),
  t('role', 'access point policy', 'ap', 'gap', ['s3-ap']),
  t('ap', 'fronts', 'bucket', 'gap', ['s3-ap']),
  t('role', 'can control', 'compute', 'gap', ['aws-gaad']),
  t('compute', 'runs as', 'role', 'raw', ['cai']),
  t('compute', 'same machine', 'host', 'raw', ['cai']),
  t('local_acct', 'logs on', 'host', 'built', ['defend', 'winsec', 'entity-store']),
  t('local_acct', 'resolved to', 'ad_acct', 'built', ['entity-store']),
  t('okta_user', 'resolved to', 'ad_acct', 'built', ['entity-store']),
  t('host', 'credentials left', 'ad_acct', 'live', ['winsec', 'defend']),
  t('ad_acct', 'member of', 'ad_group', 'raw', ['ad-ea']),
  t('ad_group', 'nested in', 'ad_group', 'raw', ['ad-ea']),
  t('ad_group', 'local admin', 'host', 'gap', ['local-admin', 'winsec']),
  t('ad_acct', 'local admin', 'host', 'gap', ['local-admin', 'winsec']),
  t('ad_acct', 'owns', 'ad_acct', 'gap', ['ad-ea']),
  t('host', 'stores credentials', 'ad_acct', 'gap', ['ad-ea']),
  t('ad_acct', 'can replicate', 'ad_group', 'gap', ['ad-ea']),
  t('okta_user', 'owns', 'local_acct', 'gap', ['jamf-pro']),
  t('iam_user', 'member of', 'iam_group', 'gap', ['aws-gaad']),
  t('iam_group', 'group policy', 'bucket', 'gap', ['aws-gaad']),
  t('iam_user', 'user policy', 'bucket', 'raw', ['cai', 'aws-gaad']),
];

export const isNodeType = (value: string): value is NodeType =>
  (NODE_TYPES as readonly string[]).includes(value);

export const findTriple = (from: NodeType, kind: string, to: NodeType): Triple | undefined =>
  TRIPLES.find((x) => x.from === from && x.kind === kind && x.to === to);
