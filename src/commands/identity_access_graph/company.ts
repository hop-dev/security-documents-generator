import { Faker, en } from '@faker-js/faker';
import { DEPARTMENTS } from '../org_data/data/departments.ts';
import { hasEntitySource } from './documents.ts';
import { COMPANY_DOMAIN, entityId, hostUuid, nodeName, seededEmail } from './ids.ts';
import { type Profile } from './profile.ts';
import { rngFor, type Rng } from './rng.ts';
import { type ScenarioNode } from './scenario.ts';
import { NODE_TYPES, type NodeType } from './triples.ts';

// The generated company's nodes (SPEC.md section 1, Generating at scale).
// Employees are index-addressed: everything about employee i comes from generators seeded
// with (seed, i), one stream per aspect, so any code can rebuild employee i alone.
// Shared targets (groups, roles, buckets, ...) are the backbone: built once, kept in memory.

/** Fixed: changing it would change the output for a seed. */
export const CHUNK_SIZE = 1000;

export type Tier = 0 | 1 | 2;

export interface CompanyNode extends ScenarioNode {
  /** The employee this node was generated for (employee nodes only). */
  slot?: number;
  /** An extra AD admin account, not the person's daily one. */
  admin?: true;
  department?: string;
  tier?: Tier;
}

export interface Employee {
  index: number;
  department: string;
  nodes: CompanyNode[];
}

/** Host tiers: domain controllers, servers, workstations (guess; not in the profile yet). */
const HOST_TIERS: Array<[Tier, number]> = [
  [0, 0.01],
  [1, 0.14],
  [2, 0.85],
];

/** The share of hosts in a tier. */
export const hostTierShare = (tier: Tier): number => HOST_TIERS.find(([t]) => t === tier)?.[1] ?? 0;

/** Generated AD groups that administer hosts of a tier (guess). */
const AD_GROUP_TIERS: Array<[Tier | undefined, number]> = [
  [0, 0.02],
  [1, 0.08],
  [2, 0.15],
  [undefined, 0.75],
];

/** Node types owned by an employee slot; every other type is backbone. */
export const EMPLOYEE_TYPES: readonly NodeType[] = ['okta_user', 'ad_acct', 'host', 'local_acct'];
const ONE_PER_EMPLOYEE = ['okta_user', 'ad_acct'];

const OKTA_BUILT_INS = ['Everyone'];
const AD_BUILT_INS = ['Domain Users', 'Domain Admins', 'Domain Computers', 'Enterprise Admins'];
const DEPARTMENT_NAMES = DEPARTMENTS.map((d) => d.name);

const WORDS = [
  'atlas',
  'beacon',
  'cobalt',
  'delta',
  'ember',
  'falcon',
  'granite',
  'harbor',
  'iris',
  'juniper',
  'kestrel',
  'lumen',
  'meridian',
  'nova',
  'onyx',
  'pioneer',
  'quartz',
  'raven',
  'summit',
  'tundra',
];

const weighted = <T>(rng: Rng, options: Array<[T, number]>): T => {
  let x = rng.next() * options.reduce((s, [, w]) => s + w, 0);
  for (const [v, w] of options) if ((x -= w) < 0) return v;
  return options[options.length - 1][0];
};

const pickDepartment = (rng: Rng): string =>
  weighted(
    rng,
    DEPARTMENTS.map((d) => [d.name, d.percentage]),
  );

/** floor(rate), plus one more with the fractional part as probability. */
const countFor = (rate: number, rng: Rng): number =>
  Math.floor(rate) + (rng.next() < rate - Math.floor(rate) ? 1 : 0);

const rate = (p: Profile, type: string) => p.perEmployee[type] ?? 0;

const slug = (s: string) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const faker = new Faker({ locale: [en] });

/** Builds a company node: id, stored name and fields. Used for planted pathology nodes too. */
export const node = (
  p: Profile,
  fields: { type: NodeType; name: string; email?: string; host?: CompanyNode['host'] } & Pick<
    CompanyNode,
    'slot' | 'department' | 'tier'
  >,
): CompanyNode => {
  const id = entityId(
    { type: fields.type, name: fields.name, email: fields.email, hostId: fields.host?.id },
    p.seed,
  );
  return {
    localId: id,
    type: fields.type,
    name: nodeName(fields, p.seed),
    entityId: id,
    ...(fields.email && { email: seededEmail(fields.email, p.seed) }),
    blindSpot: false,
    ...(fields.host && { host: fields.host }),
    ...(fields.slot !== undefined && { slot: fields.slot }),
    ...(fields.department && { department: fields.department }),
    ...(fields.tier !== undefined && { tier: fields.tier }),
  };
};

export interface HostSpec {
  name: string;
  tier: Tier;
}

/** Employee i's hosts, from their own stream, so a local account elsewhere can find them. */
export const hostsOf = (p: Profile, i: number): HostSpec[] => {
  const rng = rngFor(p.seed, 'employee', i, 'hosts');
  const n = countFor(rate(p, 'host'), rng);
  return Array.from({ length: n }, (_, k) => {
    const tier = weighted(rng, HOST_TIERS);
    const name =
      tier === 0
        ? `dc-${i}-${k}`
        : tier === 1
          ? `srv-${WORDS[rng.int(0, WORDS.length - 1)]}-${i}-${k}`
          : `ws-${i}-${k}`;
    return { name, tier };
  });
};

/** The host a local account sits on: one of its own employee's, else the next employee's that has one. */
const hostForLocal = (p: Profile, i: number, k: number): HostSpec => {
  for (let d = 0; d < p.employees; d++) {
    const j = (i + d) % p.employees;
    const hosts = hostsOf(p, j);
    if (hosts.length > 0) return hosts[k % hosts.length];
  }
  throw new Error('profile: local accounts need hosts, but per_employee.host gives none');
};

/** Employee i's department, from its own stream. */
export const departmentOf = (p: Profile, i: number): string =>
  pickDepartment(rngFor(p.seed, 'employee', i, 'department'));

export const employee = (p: Profile, i: number): Employee => {
  faker.seed([p.seed, i]);
  const first = faker.person.firstName();
  const last = faker.person.lastName();
  const person = `${slug(first)}.${slug(last)}`;
  const email = `${person}.${i}@${COMPANY_DOMAIN}`;
  const department = departmentOf(p, i);
  const base = { slot: i, department };
  const nodes: CompanyNode[] = [];

  if (
    rate(p, 'okta_user') > 0 &&
    rngFor(p.seed, 'employee', i, 'okta').next() < rate(p, 'okta_user')
  ) {
    nodes.push(node(p, { ...base, type: 'okta_user', name: person, email }));
  }
  if (rate(p, 'ad_acct') > 0 && rngFor(p.seed, 'employee', i, 'ad').next() < rate(p, 'ad_acct')) {
    nodes.push(
      node(p, { ...base, type: 'ad_acct', name: `${slug(first)[0]}${slug(last)}${i}`, email }),
    );
  }
  const admins = countFor(rate(p, 'admin_acct'), rngFor(p.seed, 'employee', i, 'admin'));
  for (let k = 0; k < admins; k++) {
    nodes.push({
      ...node(p, {
        ...base,
        type: 'ad_acct',
        name: `adm-${slug(first)[0]}${slug(last)}${i}${k ? `-${k}` : ''}`,
      }),
      admin: true,
    });
  }
  for (const h of hostsOf(p, i)) {
    nodes.push(
      node(p, {
        ...base,
        type: 'host',
        name: h.name,
        tier: h.tier,
        host: { id: hostUuid(h.name, p.seed), name: h.name },
      }),
    );
  }
  const locals = countFor(rate(p, 'local_acct'), rngFor(p.seed, 'employee', i, 'local'));
  for (let k = 0; k < locals; k++) {
    const h = hostForLocal(p, i, k);
    nodes.push(
      node(p, {
        ...base,
        type: 'local_acct',
        name: `${person}.${i}`,
        host: { id: hostUuid(h.name, p.seed), name: h.name },
      }),
    );
  }
  return { index: i, department, nodes };
};

export const chunkCount = (p: Profile): number => Math.ceil(p.employees / CHUNK_SIZE);

/** All nodes of the employees in chunk c: employees c*1000 up to the next chunk. */
export const employeeChunk = (p: Profile, c: number): CompanyNode[] => {
  const out: CompanyNode[] = [];
  const end = Math.min(p.employees, (c + 1) * CHUNK_SIZE);
  for (let i = c * CHUNK_SIZE; i < end; i++) out.push(...employee(p, i).nodes);
  return out;
};

export interface Backbone {
  nodes: CompanyNode[];
  /** Stable company names scenarios can reference: `@Everyone`, `@okta:Operations`, ... */
  byName: Map<string, CompanyNode>;
}

/** Checks every node type the profile asks for can be built, before building anything. */
const checkTypes = (p: Profile) => {
  for (const [type, r] of Object.entries(p.perEmployee)) {
    if (ONE_PER_EMPLOYEE.includes(type) && r > 1) {
      throw new Error(`profile: per_employee.${type}: at most 1 (one per employee)`);
    }
    const t = (type === 'admin_acct' ? 'ad_acct' : type) as NodeType;
    try {
      entityId({ type: t, name: 'x', email: 'x@acme.com', hostId: 'h' }, p.seed);
    } catch (e) {
      throw new Error(`profile: per_employee.${type}: ${(e as Error).message}`, { cause: e });
    }
    if (!hasEntitySource(t)) {
      throw new Error(`profile: per_employee.${type}: no entity.source yet for node type ${t}`);
    }
  }
};

export const backbone = (p: Profile): Backbone => {
  checkTypes(p);
  const nodes: CompanyNode[] = [];
  const byName = new Map<string, CompanyNode>();
  const add = (n: CompanyNode, ref?: string) => {
    nodes.push(n);
    if (ref) byName.set(ref, n);
  };

  for (const name of OKTA_BUILT_INS) add(node(p, { type: 'okta_group', name }), `@${name}`);
  for (const name of AD_BUILT_INS) add(node(p, { type: 'ad_group', name }), `@${name}`);
  for (const d of DEPARTMENT_NAMES) {
    add(node(p, { type: 'okta_group', name: d, department: d }), `@okta:${d}`);
    add(node(p, { type: 'ad_group', name: d, department: d }), `@ad:${d}`);
  }
  const builtIns = (t: NodeType) => nodes.filter((n) => n.type === t).length;

  for (const type of NODE_TYPES) {
    if (EMPLOYEE_TYPES.includes(type)) continue;
    const toGenerate = Math.round(p.employees * rate(p, type)) - builtIns(type);
    for (let k = 0; k < toGenerate; k++) {
      const rng = rngFor(p.seed, 'backbone', type, k);
      const department = pickDepartment(rng);
      const word = WORDS[rng.int(0, WORDS.length - 1)];
      // AD groups may administer a host tier; cloud instances are servers (tier 1).
      const tier =
        type === 'ad_group' ? weighted(rng, AD_GROUP_TIERS) : type === 'compute' ? 1 : undefined;
      add(
        node(p, {
          type,
          name: `${slug(department).slice(0, 4)}-${word}-${type.replace('_', '-')}-${k}`,
          department,
          tier,
        }),
      );
    }
  }
  return { nodes, byName };
};
