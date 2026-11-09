import { existsSync, readdirSync, readFileSync } from 'fs';
import { EMPLOYEE_TYPES, hostTierShare, type Tier } from './company.ts';
import { meanCount, parseDistribution, type Distribution } from './distributions.ts';
import { DEFAULT_ARRAYS_CAP } from './documents.ts';
import { findTriple, isNodeType, TRIPLES, type NodeType, type Triple } from './triples.ts';

// The profile: every advanced setting for a generated company (SPEC.md section 1, Profile).
// loadProfile checks it all at load, so a bad profile fails before anything is generated.

export const DEFAULT_MAX_NODES = 50_000_000;

/** Fields a `same` picker can match on. */
const SAME_FIELDS = ['department', 'tier'] as const;

/** Planted pathologies and the numbers each takes besides `on` (SPEC.md section 4). */
const PATHOLOGY_KNOBS: Record<string, readonly string[]> = {
  hub_past_cap: ['members'],
  single_choke_link: ['share_cut'],
  msol_bypass: [],
  indirect_role_chain: ['depth'],
  breakglass_role: [],
  false_merge: [],
};

/** Besides node types, per_employee takes admin accounts: extra AD accounts a person owns. */
const PER_EMPLOYEE_EXTRA = ['admin_acct'] as const;

export type Picker =
  | { fixed: string }
  | { same: (typeof SAME_FIELDS)[number] }
  /** Fills whatever the draw leaves after the pickers before it; always last. */
  | { random: true; skew: number }
  | { via: Array<{ kind: string; type: NodeType }> }
  | { own: true };

export interface EdgeRow {
  from: NodeType;
  /** Sources are admin accounts only: `admin_acct` in the profile's triple. */
  adminsOnly: boolean;
  kind: string;
  to: NodeType;
  triple: Triple;
  perSource: Distribution;
  targets: Picker[];
  /** Where the numbers come from ("guess", "ADSynth", ...). */
  source: string;
  /** 2 and up for a later row with the same source, kind and target type, so it draws apart. */
  repeat?: number;
}

/** The row's source as the profile names it: a node type, or `admin_acct`. */
export const rowSource = (r: Pick<EdgeRow, 'from' | 'adminsOnly'>): string =>
  r.adminsOnly ? 'admin_acct' : r.from;

/** Nodes marked `extreme_impact`: the targets blast radius and choke points walk back from. */
export interface CrownJewels {
  /** Company nodes by `@` name, e.g. `@Domain Admins`. */
  names: string[];
  /** Up to this many generated nodes of each shared type, chosen by seed. */
  perType: Partial<Record<NodeType, number>>;
}

/** One named node with the same edge to a share of all nodes of a type: a hub on purpose. */
export interface HubGrant {
  /** A company node by `@` name, e.g. `@Domain Users`. */
  from: string;
  kind: string;
  to: NodeType;
  /** Hosts of this tier only. */
  tier?: Tier;
  /** The share of `to` nodes that get the edge, from 0 to 1. */
  share: number;
  /** Where the share comes from ("guess", ...). */
  source: string;
}

/** One edge between two named company nodes, such as a built-in group nesting. */
export interface NamedEdge {
  /** Company nodes by `@` name. */
  from: string;
  kind: string;
  to: string;
  /** Where the edge comes from ("AD built-in", ...). */
  source: string;
}

export interface Profile {
  seed: number;
  employees: number;
  perEmployee: Record<string, number>;
  /** Ordered so every row comes after the rows its `via` pickers follow. */
  edges: EdgeRow[];
  logonCount: Distribution;
  arraysCap: number;
  pathologies: Record<string, { on: boolean } & Record<string, number | boolean>>;
  blindSpots: Partial<Record<NodeType, number>>;
  crownJewels: CrownJewels;
  hubGrants: HubGrant[];
  namedEdges: NamedEdge[];
}

const TOP_KEYS = [
  'seed',
  'employees',
  'per_employee',
  'edges',
  'logon_count',
  'arrays_cap',
  'pathologies',
  'blind_spots',
  'crown_jewels',
  'hub_grants',
  'named_edges',
];

const TIERS: readonly Tier[] = [0, 1, 2];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const fail = (msg: string): never => {
  throw new Error(`profile: ${msg}`);
};
const tripleLabel = (from: string, kind: string, to: string) => `${from} -[${kind}]-> ${to}`;

const wholeNumber = (v: unknown, what: string, min: number): number =>
  Number.isInteger(v) && (v as number) >= min
    ? (v as number)
    : fail(`${what} must be a whole number of at least ${min}`);

const isAtName = (v: unknown): v is string => typeof v === 'string' && /^@.+/.test(v);

const checkKeys = (raw: Record<string, unknown>, allowed: readonly string[], where: string) => {
  for (const k of Object.keys(raw))
    if (!allowed.includes(k)) fail(`${where}: unknown field "${k}"`);
};

const parseCrownJewels = (raw: unknown): CrownJewels => {
  if (raw === undefined) return { names: [], perType: {} };
  if (!isObj(raw)) return fail('crown_jewels must be an object with names and per_type');
  checkKeys(raw, ['names', 'per_type'], 'crown_jewels');
  const names = raw.names ?? [];
  if (!Array.isArray(names) || !names.every(isAtName)) {
    fail('crown_jewels.names: a list of @ names, e.g. ["@Domain Admins"]');
  }
  const rawPerType = raw.per_type ?? {};
  if (!isObj(rawPerType)) fail('crown_jewels.per_type must be an object of node type: count');
  const perType: CrownJewels['perType'] = {};
  for (const [type, v] of Object.entries(rawPerType as object)) {
    if (!isNodeType(type) || EMPLOYEE_TYPES.includes(type)) {
      fail(`crown_jewels.per_type: "${type}" is not a shared node type (bucket, role, db, ...)`);
    }
    perType[type as NodeType] = wholeNumber(v, `crown_jewels.per_type.${type}`, 0);
  }
  return { names: names as string[], perType };
};

const parseHubGrant = (raw: unknown, i: number): HubGrant => {
  const where = `hub_grants[${i}]`;
  if (!isObj(raw)) return fail(`${where}: must be an object`);
  checkKeys(raw, ['from', 'kind', 'to', 'tier', 'share', 'source'], where);
  const { from, kind, to, tier, share, source } = raw;
  if (!isAtName(from)) fail(`${where}.from: an @ name, e.g. "@Domain Users"`);
  if (typeof to !== 'string' || !isNodeType(to)) fail(`${where}.to: unknown node type "${to}"`);
  if (typeof kind !== 'string' || !TRIPLES.some((t) => t.kind === kind && t.to === to)) {
    fail(`${where}: no triple has kind "${kind}" ending at ${to}`);
  }
  if (tier !== undefined && (to !== 'host' || !TIERS.includes(tier as Tier))) {
    fail(`${where}.tier: hosts only, 0 (domain controllers), 1 (servers) or 2 (workstations)`);
  }
  if (!isNum(share) || share < 0 || share > 1) fail(`${where}.share: must be from 0 to 1`);
  if (typeof source !== 'string' || source === '')
    fail(`${where}.source: say where the share comes from ("guess", ...)`);
  return {
    from: from as string,
    kind: kind as string,
    to: to as NodeType,
    ...(tier !== undefined && { tier: tier as Tier }),
    share: share as number,
    source: source as string,
  };
};

const parseNamedEdge = (raw: unknown, i: number): NamedEdge => {
  const where = `named_edges[${i}]`;
  if (!isObj(raw)) return fail(`${where}: must be an object`);
  checkKeys(raw, ['from', 'kind', 'to', 'source'], where);
  const { from, kind, to, source } = raw;
  if (!isAtName(from)) fail(`${where}.from: an @ name, e.g. "@Domain Admins"`);
  if (!isAtName(to)) fail(`${where}.to: an @ name, e.g. "@Administrators"`);
  if (typeof kind !== 'string' || !TRIPLES.some((t) => t.kind === kind)) {
    fail(`${where}.kind: no triple has kind "${kind}"`);
  }
  if (typeof source !== 'string' || source === '')
    fail(`${where}.source: say where the edge comes from ("AD built-in", ...)`);
  return { from: from as string, kind: kind as string, to: to as string, source: source as string };
};

const parseNamedEdges = (raw: unknown): NamedEdge[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return fail('named_edges must be a list');
  return raw.map(parseNamedEdge);
};

const parseHubGrants = (raw: unknown): HubGrant[] => {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return fail('hub_grants must be a list');
  return raw.map(parseHubGrant);
};

const parsePicker = (
  raw: unknown,
  row: { from: NodeType; to: NodeType },
  where: string,
): Picker => {
  const bad = (msg: string): never => fail(`${where}: ${msg}`);
  if (!isObj(raw)) return bad('a picker must be an object');
  const keys = Object.keys(raw);
  const has = (k: string) => keys.includes(k);
  if (has('fixed') && keys.length === 1) {
    return typeof raw.fixed === 'string' && /^@.+/.test(raw.fixed)
      ? { fixed: raw.fixed }
      : bad('fixed: an @ name, e.g. "@Everyone"');
  }
  if (has('same') && keys.length === 1) {
    return (SAME_FIELDS as readonly unknown[]).includes(raw.same)
      ? { same: raw.same as Picker extends { same: infer F } ? F : never }
      : bad(`same: ${JSON.stringify(raw.same)} is not one of ${SAME_FIELDS.join(', ')}`);
  }
  if (has('random') && keys.every((k) => k === 'random' || k === 'skew')) {
    if (raw.random !== true) bad('random: must be true (it fills what the draw leaves)');
    const skew = raw.skew ?? 0;
    if (!isNum(skew) || skew < 0)
      bad('skew: 0 or more (0 is uniform; higher makes a few targets popular)');
    return { random: true, skew: skew as number };
  }
  if (has('own') && keys.length === 1) {
    return raw.own === true ? { own: true } : bad('own: must be true');
  }
  if (has('via') && keys.length === 1) {
    if (!Array.isArray(raw.via) || raw.via.length === 0) bad('via: a list of [kind, type] steps');
    const steps: Array<{ kind: string; type: NodeType }> = [];
    let at: NodeType = row.from;
    for (const step of raw.via as unknown[]) {
      if (!Array.isArray(step) || step.length !== 2 || typeof step[0] !== 'string') {
        bad('via: each step is [kind, type], e.g. ["bucket policy", "bucket"]');
      }
      const [kind, type] = step as [string, unknown];
      if (typeof type !== 'string' || !isNodeType(type) || !findTriple(at, kind, type)) {
        bad(`via step ${tripleLabel(at, kind, String(type))} is not a triple`);
      }
      steps.push({ kind, type: type as NodeType });
      at = type as NodeType;
    }
    if (at !== row.to) bad(`via ends at ${at}, not ${row.to}`);
    return { via: steps };
  }
  return bad(`unknown picker ${JSON.stringify(raw)} (fixed, same, random, via or own)`);
};

/**
 * The rule (SPEC.md, profile): per_source draws how many edges a source gets; the pickers
 * fill that number in order, and `random` takes what's left, so it comes last.
 */
const checkRandomLast = (pickers: Picker[], where: string): Picker[] => {
  const i = pickers.findIndex((p) => 'random' in p);
  if (i !== -1 && i !== pickers.length - 1)
    fail(`${where}.targets: random must be the last picker`);
  return pickers;
};

const parseRow = (raw: unknown, i: number): EdgeRow => {
  const where = `edges[${i}]`;
  if (!isObj(raw)) return fail(`${where}: must be an object`);
  for (const k of Object.keys(raw)) {
    if (!['triple', 'per_source', 'targets', 'source'].includes(k))
      fail(`${where}: unknown field "${k}"`);
  }
  const t = raw.triple;
  if (!Array.isArray(t) || t.length !== 3 || !t.every((x) => typeof x === 'string')) {
    fail(`${where}: triple must be [from type, kind, to type]`);
  }
  const [from, kind, to] = t as [string, string, string];
  // `admin_acct` is a source only: the AD accounts per_employee.admin_acct adds.
  const adminsOnly = from === 'admin_acct';
  const fromType = adminsOnly ? 'ad_acct' : from;
  const triple =
    isNodeType(fromType) && isNodeType(to) ? findTriple(fromType, kind, to) : undefined;
  if (!triple) return fail(`${where}: impossible triple ${tripleLabel(from, kind, to)}`);
  if (!Array.isArray(raw.targets) || raw.targets.length === 0)
    fail(`${where}: targets must be a non-empty list of pickers`);
  if (typeof raw.source !== 'string' || raw.source === '')
    fail(`${where}: source must say where the numbers come from ("guess", ...)`);
  return {
    from: triple.from,
    adminsOnly,
    kind,
    to: triple.to,
    triple,
    perSource: parseDistribution(raw.per_source, `profile: ${where}.per_source`),
    targets: checkRandomLast(
      (raw.targets as unknown[]).map((p, j) => parsePicker(p, triple, `${where}.targets[${j}]`)),
      where,
    ),
    source: raw.source as string,
  };
};

/** Orders rows so each comes after the rows its `via` pickers follow; a cycle fails. */
const orderRows = (rows: EdgeRow[]): EdgeRow[] => {
  const key = (from: string, kind: string, to: string) => `${from}|${kind}|${to}`;
  const index = new Map(rows.map((r, i) => [key(rowSource(r), r.kind, r.to), i]));
  const deps = rows.map((r) => {
    const out = new Set<number>();
    for (const p of r.targets) {
      if (!('via' in p)) continue;
      let at: NodeType = r.from;
      for (const s of p.via) {
        const d = index.get(key(at, s.kind, s.type));
        if (d !== undefined) out.add(d);
        at = s.type;
      }
    }
    return out;
  });
  const done: number[] = [];
  const state = new Array<0 | 1 | 2>(rows.length).fill(0);
  const visit = (i: number, stack: number[]) => {
    if (state[i] === 2) return;
    if (state[i] === 1) {
      const cycle = [...stack.slice(stack.indexOf(i)), i].map((j) =>
        tripleLabel(rowSource(rows[j]), rows[j].kind, rows[j].to),
      );
      fail(`via cycle: ${cycle.join(' follows ')}`);
    }
    state[i] = 1;
    for (const d of [...deps[i]].sort((a, b) => a - b)) visit(d, [...stack, i]);
    state[i] = 2;
    done.push(i);
  };
  // Rows with no via dependencies keep their order; a via row moves after what it follows.
  for (let i = 0; i < rows.length; i++) visit(i, []);
  return done.map((i) => rows[i]);
};

/** Numbers rows that repeat an earlier row's source, kind and target type, from 2. */
const numberRepeats = (rows: EdgeRow[]): EdgeRow[] => {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = tripleLabel(rowSource(r), r.kind, r.to);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? r : { ...r, repeat: n };
  });
};

export interface ProfileOverrides {
  employees?: number;
  seed?: number;
}

export const loadProfile = (raw: unknown, overrides: ProfileOverrides = {}): Profile => {
  if (!isObj(raw)) return fail('must be a JSON object');
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) fail(`unknown section "${k}"`);

  const seed = wholeNumber(overrides.seed ?? raw.seed, 'seed', 0);
  const employees = wholeNumber(overrides.employees ?? raw.employees, 'employees', 1);

  if (!isObj(raw.per_employee))
    fail('per_employee must be an object of node type: count per employee');
  const perEmployee: Record<string, number> = {};
  for (const [type, v] of Object.entries(raw.per_employee as object)) {
    if (!isNodeType(type) && !(PER_EMPLOYEE_EXTRA as readonly string[]).includes(type)) {
      fail(`per_employee: unknown node type "${type}"`);
    }
    if (!isNum(v) || v < 0) fail(`per_employee.${type}: must be a number of 0 or more`);
    perEmployee[type] = v as number;
  }

  if (!Array.isArray(raw.edges)) fail('edges must be a list of rows');
  const rows = (raw.edges as unknown[]).map(parseRow);
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const k = tripleLabel(rowSource(r), r.kind, r.to);
    if (seen.has(k)) fail(`edges[${i}]: ${k} appears twice`);
    seen.add(k);
  });

  const pathologies: Profile['pathologies'] = {};
  for (const [name, v] of Object.entries(isObj(raw.pathologies) ? raw.pathologies : {})) {
    const knobs = PATHOLOGY_KNOBS[name] ?? fail(`pathologies: unknown pathology "${name}"`);
    if (!isObj(v) || typeof v.on !== 'boolean')
      fail(`pathologies.${name}: needs "on": true or false`);
    for (const [k, x] of Object.entries(v as object)) {
      if (k === 'on') continue;
      if (!knobs.includes(k)) fail(`pathologies.${name}: unknown knob "${k}"`);
      if (!isNum(x)) fail(`pathologies.${name}.${k}: must be a number`);
    }
    pathologies[name] = v as Profile['pathologies'][string];
  }

  const blindSpots: Profile['blindSpots'] = {};
  for (const [type, v] of Object.entries(isObj(raw.blind_spots) ? raw.blind_spots : {})) {
    if (!isNodeType(type)) fail(`blind_spots: unknown node type "${type}"`);
    if (!isNum(v) || v < 0 || v > 1) fail(`blind_spots.${type}: must be from 0 to 1`);
    blindSpots[type as NodeType] = v as number;
  }

  return {
    seed,
    employees,
    perEmployee,
    edges: orderRows(numberRepeats(rows)),
    logonCount: parseDistribution(raw.logon_count, 'profile: logon_count'),
    arraysCap:
      raw.arrays_cap === undefined
        ? DEFAULT_ARRAYS_CAP
        : wholeNumber(raw.arrays_cap, 'arrays_cap', 0),
    pathologies,
    blindSpots,
    crownJewels: parseCrownJewels(raw.crown_jewels),
    hubGrants: parseHubGrants(raw.hub_grants),
    namedEdges: parseNamedEdges(raw.named_edges),
  };
};

const PROFILES_DIR = new URL('./profiles/', import.meta.url);

/** Reads a profile bundled with the command, by name (`default`, `scale-target`). */
export const readBundledProfile = (name: string): unknown => {
  const file = new URL(`${name}.json`, PROFILES_DIR);
  if (!/^[a-z0-9-]+$/.test(name) || !existsSync(file)) {
    const bundled = readdirSync(PROFILES_DIR).map((f) => f.replace(/\.json$/, ''));
    throw new Error(`no bundled profile "${name}" (bundled: ${bundled.join(', ')})`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
};

export interface SizeEstimate {
  nodes: number;
  edges: number;
}

/**
 * Nodes: employees x per_employee. Edges: source nodes x mean out-degree, per row, plus each
 * hub grant's share of its target nodes.
 */
export const estimateSize = (p: Profile): SizeEstimate => {
  const count = (type: string) => Math.round(p.employees * (p.perEmployee[type] ?? 0));
  const nodes = Object.keys(p.perEmployee).reduce((n, t) => n + count(t), 0);
  const rowEdges = p.edges.reduce(
    (n, r) => n + Math.round(count(rowSource(r)) * meanCount(r.perSource)),
    0,
  );
  const grantEdges = p.hubGrants.reduce(
    (n, g) =>
      n + Math.round(count(g.to) * g.share * (g.tier === undefined ? 1 : hostTierShare(g.tier))),
    0,
  );
  return { nodes, edges: rowEdges + grantEdges };
};

const fmt = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)}B`
    : n >= 1e6
      ? `${Math.round(n / 1e6)}M`
      : n.toLocaleString('en-US');

export const describeSize = (e: SizeEstimate) =>
  `Estimated ${fmt(e.nodes)} nodes, ${fmt(e.edges)} edges.`;

/** The 50M guardrail: refuse above the limit, and say how to go over on purpose. */
export const checkSize = (e: SizeEstimate, maxNodes: number = DEFAULT_MAX_NODES): void => {
  if (e.nodes <= maxNodes) return;
  const suggest = Math.ceil(e.nodes / 1e7) * 1e7;
  throw new Error(
    `${describeSize(e)} Limit is ${fmt(maxNodes)} nodes; pass --max-nodes ${suggest} to run anyway.`,
  );
};
