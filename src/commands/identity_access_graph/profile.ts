import { readFileSync } from 'fs';
import { meanCount, parseDistribution, type Distribution } from './distributions.ts';
import { findTriple, isNodeType, type NodeType, type Triple } from './triples.ts';

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
  kind: string;
  to: NodeType;
  triple: Triple;
  perSource: Distribution;
  targets: Picker[];
  /** Where the numbers come from ("guess", "ADSynth", ...). */
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
];

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
  const triple = isNodeType(from) && isNodeType(to) ? findTriple(from, kind, to) : undefined;
  if (!triple) return fail(`${where}: impossible triple ${tripleLabel(from, kind, to)}`);
  if (!Array.isArray(raw.targets) || raw.targets.length === 0)
    fail(`${where}: targets must be a non-empty list of pickers`);
  if (typeof raw.source !== 'string' || raw.source === '')
    fail(`${where}: source must say where the numbers come from ("guess", ...)`);
  return {
    from: triple.from,
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
  const index = new Map(rows.map((r, i) => [key(r.from, r.kind, r.to), i]));
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
        tripleLabel(rows[j].from, rows[j].kind, rows[j].to),
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
    const k = tripleLabel(r.from, r.kind, r.to);
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
    edges: orderRows(rows),
    logonCount: parseDistribution(raw.logon_count, 'profile: logon_count'),
    arraysCap: wholeNumber(raw.arrays_cap, 'arrays_cap', 0),
    pathologies,
    blindSpots,
  };
};

/** Reads a profile bundled with the command, by name (`default`). */
export const readBundledProfile = (name: string): unknown => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`not a bundled profile name: "${name}"`);
  return JSON.parse(readFileSync(new URL(`./profiles/${name}.json`, import.meta.url), 'utf8'));
};

export interface SizeEstimate {
  nodes: number;
  edges: number;
}

/** Nodes: employees x per_employee. Edges: source nodes x mean out-degree, per row. */
export const estimateSize = (p: Profile): SizeEstimate => {
  const count = (type: string) => Math.round(p.employees * (p.perEmployee[type] ?? 0));
  const nodes = Object.keys(p.perEmployee).reduce((n, t) => n + count(t), 0);
  const edges = p.edges.reduce((n, r) => n + Math.round(count(r.from) * meanCount(r.perSource)), 0);
  return { nodes, edges };
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
