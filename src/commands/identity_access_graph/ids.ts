import { createHash } from 'crypto';
import { type NodeType, type Status } from './triples.ts';

/** The fictional company every run is built around; the seed goes into its domain. */
export const COMPANY_DOMAIN = 'acme.com';

/** The one AWS region every run uses. */
export const AWS_REGION = 'us-east-1';

/** Logons above this count are `accesses_frequently` (Kibana ACCESS_COUNT_THRESHOLD). */
const ACCESS_COUNT_THRESHOLD = 4;

/** acme.com + seed 42 → acme-s42.com: every id built from it is unique to the run. */
export const seededDomain = (domain: string, seed: number): string => {
  const dot = domain.indexOf('.');
  if (dot <= 0) throw new Error(`not a domain: "${domain}"`);
  return `${domain.slice(0, dot)}-s${seed}${domain.slice(dot)}`;
};

/** The run's AWS account id: the seed, as 12 digits. */
export const awsAccountId = (seed: number): string => {
  if (!Number.isInteger(seed) || seed < 0 || seed >= 10 ** 12) {
    throw new Error(`seed must be an integer from 0 to 999999999999, got ${seed}`);
  }
  return String(seed).padStart(12, '0');
};

/** Rewrites an email's domain to the run's seeded domain. */
export const seededEmail = (email: string, seed: number): string => {
  const at = email.lastIndexOf('@');
  if (at <= 0) throw new Error(`not an email: "${email}"`);
  return `${email.slice(0, at)}@${seededDomain(email.slice(at + 1), seed)}`;
};

/**
 * A v4-shaped UUID derived from (seed, name), stable for a seed and unique per run: a host's
 * id (like a Defend agent id), and a KMS key id.
 */
export const hostUuid = (name: string, seed: number): string => {
  const h = createHash('sha256').update(`${seed}|${name}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export interface IdInput {
  type: NodeType;
  name: string;
  email?: string;
  /** For a local account: its host's UUID. */
  hostId?: string;
  /** For a compute node: an EC2 instance (default) or a Lambda function. */
  service?: 'ec2' | 'lambda';
}

/**
 * The name a node is stored under. An AD account without an email and a GitHub login change:
 * the id is built from the name alone, so the name carries the seed (like bucket names).
 */
export const nodeName = (node: Pick<IdInput, 'type' | 'name' | 'email'>, seed: number): string =>
  (node.type === 'ad_acct' && !node.email) || node.type === 'gh_user'
    ? `${node.name}-s${seed}`
    : node.name;

/** The Entity Store `entity.id` for a node (SPEC.md section 2), with the seed in it. */
export const entityId = (node: IdInput, seed: number): string => {
  switch (node.type) {
    case 'okta_user':
      if (!node.email)
        throw new Error(`okta_user "${node.name}" needs an email: its id is built from it`);
      return `user:${seededEmail(node.email, seed)}@okta`;
    case 'ad_acct':
      return `user:${node.email ? seededEmail(node.email, seed) : nodeName(node, seed)}@active_directory`;
    case 'local_acct':
      if (!node.hostId)
        throw new Error(`local_acct "${node.name}" needs its host: its id names the host`);
      return `user:${node.name}@${node.hostId}@local`;
    case 'host':
      return `host:${hostUuid(node.name, seed)}`;
    case 'okta_group':
      return `group:${node.name}@${seededDomain(COMPANY_DOMAIN, seed)}@okta`;
    case 'role':
      return `arn:aws:iam::${awsAccountId(seed)}:role/${node.name}`;
    case 'bucket':
      return `arn:aws:s3:::${node.name}-s${seed}`;
    case 'iam_user':
      return `user:arn:aws:iam::${awsAccountId(seed)}:user/${node.name}@aws`;
    // Someone else's AWS account: 12 digits from (seed, name), never the run's own account.
    case 'ext_acct': {
      const digits = BigInt(
        `0x${createHash('sha256').update(`${seed}|${node.name}`).digest('hex').slice(0, 15)}`,
      );
      return `aws:account:${String(10n ** 11n + (digits % (9n * 10n ** 11n)))}`;
    }
    case 'repo':
      return `github:repo:acme-s${seed}/${node.name}`;
    case 'ad_group':
      return `group:${node.name}@${seededDomain(COMPANY_DOMAIN, seed)}@active_directory`;
    case 'saas':
      return `okta:app:${node.name}@${seededDomain(COMPANY_DOMAIN, seed)}`;
    case 'key':
      return `arn:aws:kms:${AWS_REGION}:${awsAccountId(seed)}:key/${hostUuid(`key|${node.name}`, seed)}`;
    case 'secret':
      return `arn:aws:secretsmanager:${AWS_REGION}:${awsAccountId(seed)}:secret:${node.name}`;
    // A Redshift cluster: the only database the scenarios use so far.
    case 'db':
      return `arn:aws:redshift:${AWS_REGION}:${awsAccountId(seed)}:cluster:${node.name}`;
    // An EC2 instance, or a Lambda function with service: lambda.
    case 'gh_user':
      return `user:${nodeName(node, seed)}@github`;
    case 'gh_team':
      return `group:${node.name}@${seededDomain(COMPANY_DOMAIN, seed)}@github`;
    case 'iam_group':
      return `group:${node.name}@${seededDomain(COMPANY_DOMAIN, seed)}@aws`;
    case 'ap':
      return `arn:aws:s3:${AWS_REGION}:${awsAccountId(seed)}:accesspoint/${node.name}`;
    case 'compute': {
      if (node.service === 'lambda') {
        return `arn:aws:lambda:${AWS_REGION}:${awsAccountId(seed)}:function:${node.name}`;
      }
      const h = createHash('sha256').update(`${seed}|${node.name}`).digest('hex');
      return `arn:aws:ec2:${AWS_REGION}:${awsAccountId(seed)}:instance/i-${h.slice(0, 17)}`;
    }
    default:
      throw new Error(`no id rule yet for node type ${node.type}`);
  }
};

/** model.js kind → stored relationship kind. `logons` only matters for `logs on`. */
export const edgeKind = (kind: string, logons?: number): string => {
  if (kind === 'logs on') {
    return (logons ?? 1) > ACCESS_COUNT_THRESHOLD ? 'accesses_frequently' : 'accesses_infrequently';
  }
  if (kind === 'resolved to') return 'resolution.resolved_to';
  return kind.toLowerCase().replace(/ /g, '_');
};

/** current: Kibana builds this edge today; future: the north-star graph adds it. */
export const graphVersion = (status: Status): 'current' | 'future' =>
  status === 'built' ? 'current' : 'future';
