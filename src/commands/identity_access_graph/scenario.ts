import { readFileSync } from 'fs';
import { edgeKind, entityId, graphVersion, hostUuid, nodeName, seededEmail } from './ids.ts';
import { findTriple, isNodeType, type NodeType } from './triples.ts';

// A scenario is a small hand-written graph telling one story (SPEC.md section 5).
// loadScenario checks it and turns it into entity ids and edge documents; it writes nothing.

const CRITICALITY = ['low_impact', 'medium_impact', 'high_impact', 'extreme_impact'] as const;
type Criticality = (typeof CRITICALITY)[number];

const EDGE_OPTIONS = ['logons', 'first_seen', 'last_seen'] as const;

export interface ScenarioNode {
  localId: string;
  type: NodeType;
  name: string;
  entityId: string;
  email?: string;
  criticality?: Criticality;
  blindSpot: boolean;
  /** A host itself, or a local account's host: the UUID and the readable name. */
  host?: { id: string; name: string };
  /** A compute node's service: ec2 (default) or lambda. */
  service?: 'ec2' | 'lambda';
}

export interface EdgeDoc {
  src: string;
  kind: string;
  dst: string;
  graph_version: 'current' | 'future';
  source: string;
  first_seen: string;
  last_seen: string;
}

export interface LoadedScenario {
  name: string;
  description: string;
  nodes: ScenarioNode[];
  edges: EdgeDoc[];
  /** Edges to `@` company nodes, skipped because the scenario is loaded alone. */
  skipped: string[];
}

/** A company node a planted scenario can name with `@`. */
export interface CompanyRef {
  entityId: string;
  type: NodeType;
}

export interface LoadOptions {
  seed: number;
  /** The run time; relative edge times (`-3d`) count back from it. */
  now: Date;
  /** Planted into a company: `@` names resolve here. Loaded alone: absent, `@` edges are skipped. */
  company?: ReadonlyMap<string, CompanyRef>;
}

const fail = (scenario: string, message: string): never => {
  throw new Error(`scenario "${scenario}": ${message}`);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown, what: string, scenario: string): string =>
  typeof v === 'string' && v.length > 0 ? v : fail(scenario, `${what} must be a non-empty string`);

/** `-3d` → now minus 3 days. Only days, only in the past. */
const relativeTime = (v: unknown, now: Date, what: string, scenario: string): string => {
  const m = typeof v === 'string' ? /^-(\d+)d$/.exec(v) : null;
  if (!m)
    return fail(
      scenario,
      `${what} must look like "-3d" (days before the run), got ${JSON.stringify(v)}`,
    );
  return new Date(now.getTime() - Number(m[1]) * 86_400_000).toISOString();
};

interface ParsedNode {
  localId: string;
  type: NodeType;
  name: string;
  email?: string;
  criticality?: Criticality;
  blindSpot: boolean;
  hostRef?: string;
  service?: 'ec2' | 'lambda';
}

const parseNode = (raw: unknown, scenario: string): ParsedNode => {
  if (!isObject(raw)) return fail(scenario, `each node must be an object`);
  const localId = str(raw.id, 'node id', scenario);
  const type = str(raw.type, `node "${localId}" type`, scenario);
  if (!isNodeType(type)) return fail(scenario, `unknown node type "${type}" (node "${localId}")`);
  const name = str(raw.name, `node "${localId}" name`, scenario);
  const email =
    raw.email === undefined ? undefined : str(raw.email, `node "${localId}" email`, scenario);
  const criticality = raw.criticality;
  if (criticality !== undefined && !(CRITICALITY as readonly unknown[]).includes(criticality)) {
    fail(
      scenario,
      `node "${localId}": criticality ${JSON.stringify(criticality)} is not one of ${CRITICALITY.join(', ')}`,
    );
  }
  if (raw.blind_spot !== undefined && typeof raw.blind_spot !== 'boolean') {
    fail(scenario, `node "${localId}": blind_spot must be true or false`);
  }
  if (raw.service !== undefined && type !== 'compute') {
    fail(scenario, `node "${localId}": only a compute node has a service`);
  }
  if (raw.service !== undefined && raw.service !== 'ec2' && raw.service !== 'lambda') {
    fail(
      scenario,
      `node "${localId}": service ${JSON.stringify(raw.service)} is not one of ec2, lambda`,
    );
  }
  if (raw.host !== undefined && type !== 'local_acct') {
    fail(scenario, `node "${localId}": only a local_acct has a host`);
  }
  if (type === 'local_acct' && raw.host === undefined) {
    fail(scenario, `node "${localId}": a local_acct needs "host", the id of its host node`);
  }
  return {
    localId,
    type,
    name,
    email,
    criticality: criticality as Criticality | undefined,
    blindSpot: raw.blind_spot === true,
    hostRef: raw.host === undefined ? undefined : str(raw.host, `node "${localId}" host`, scenario),
    service: raw.service as ParsedNode['service'],
  };
};

/** Second pass: ids, once every node is known (a local account's id names its host). */
const resolveNode = (
  n: ParsedNode,
  parsed: Map<string, ParsedNode>,
  seed: number,
  scenario: string,
): ScenarioNode => {
  let host: ScenarioNode['host'];
  if (n.type === 'host') host = { id: hostUuid(n.name, seed), name: n.name };
  if (n.hostRef !== undefined) {
    const h = parsed.get(n.hostRef);
    if (h?.type !== 'host')
      fail(scenario, `node "${n.localId}": host "${n.hostRef}" is not a host node`);
    host = { id: hostUuid((h as ParsedNode).name, seed), name: (h as ParsedNode).name };
  }
  let id: string;
  try {
    id = entityId(
      { type: n.type, name: n.name, email: n.email, hostId: host?.id, service: n.service },
      seed,
    );
  } catch (e) {
    return fail(scenario, `node "${n.localId}": ${(e as Error).message}`);
  }
  return {
    localId: n.localId,
    type: n.type,
    name: nodeName(n, seed),
    entityId: id,
    email: n.email === undefined ? undefined : seededEmail(n.email, seed),
    criticality: n.criticality,
    blindSpot: n.blindSpot,
    ...(host && { host }),
    ...(n.service && { service: n.service }),
  };
};

export const loadScenario = (raw: unknown, { seed, now, company }: LoadOptions): LoadedScenario => {
  if (!isObject(raw)) return fail('?', 'a scenario must be a JSON object');
  const name = str(raw.name, 'name', '?');
  const description = str(raw.description, 'description', name);
  if (!Array.isArray(raw.nodes)) return fail(name, 'nodes must be a list');
  if (!Array.isArray(raw.edges)) return fail(name, 'edges must be a list');

  const parsed = new Map<string, ParsedNode>();
  for (const n of raw.nodes) {
    const node = parseNode(n, name);
    if (parsed.has(node.localId)) fail(name, `duplicate node id "${node.localId}"`);
    parsed.set(node.localId, node);
  }
  const byId = new Map<string, ScenarioNode>();
  for (const n of parsed.values()) byId.set(n.localId, resolveNode(n, parsed, seed, name));

  const edges: EdgeDoc[] = [];
  const skipped: string[] = [];
  for (const e of raw.edges) {
    if (!Array.isArray(e) || e.length < 3 || e.length > 4) {
      fail(
        name,
        `each edge must be [from, kind, to] or [from, kind, to, {options}], got ${JSON.stringify(e)}`,
      );
    }
    const [fromId, kind, toId, options = {}] = e as [unknown, unknown, unknown, unknown];
    const label = `${String(fromId)} -[${String(kind)}]-> ${String(toId)}`;
    const isRef = (v: unknown): v is string => typeof v === 'string' && v.startsWith('@');
    // A company node only as a target: its own document (and its ids arrays) is the company's.
    if (isRef(fromId)) {
      fail(name, `edge ${label}: a company node (${fromId}) can only be an edge target`);
    }
    if (!company && isRef(toId)) {
      skipped.push(label);
      continue;
    }
    const from =
      byId.get(str(fromId, 'edge source', name)) ??
      fail(name, `edge ${label}: unknown node "${String(fromId)}"`);
    const to: Pick<ScenarioNode, 'type' | 'entityId' | 'host'> = isRef(toId)
      ? ((company as ReadonlyMap<string, CompanyRef>).get(toId) ??
        fail(
          name,
          `edge ${label}: "${toId}" is not a company name (there are: ${[...(company as ReadonlyMap<string, CompanyRef>).keys()].join(', ')})`,
        ))
      : (byId.get(str(toId, 'edge target', name)) ??
        fail(name, `edge ${label}: unknown node "${String(toId)}"`));
    const k = str(kind, 'edge kind', name);
    const triple = findTriple(from.type, k, to.type);
    if (!triple) return fail(name, `impossible edge: ${from.type} -[${k}]-> ${to.type} (${label})`);
    if (k === 'logs on' && from.host?.id !== to.host?.id) {
      const own = parsed.get(from.localId)?.hostRef;
      fail(name, `edge ${label}: a local account logs on only to its own host "${own}"`);
    }

    if (!isObject(options)) return fail(name, `edge ${label}: options must be an object`);
    for (const key of Object.keys(options)) {
      if (!(EDGE_OPTIONS as readonly string[]).includes(key))
        fail(name, `edge ${label}: unknown edge option "${key}"`);
    }
    if (options.logons !== undefined) {
      if (k !== 'logs on') fail(name, `edge ${label}: logons is only for "logs on" edges`);
      if (!Number.isInteger(options.logons) || (options.logons as number) < 1) {
        fail(name, `edge ${label}: logons must be a whole number of at least 1`);
      }
    }
    const lastSeen =
      options.last_seen === undefined
        ? now.toISOString()
        : relativeTime(options.last_seen, now, `edge ${label}: last_seen`, name);
    const firstSeen =
      options.first_seen === undefined
        ? lastSeen
        : relativeTime(options.first_seen, now, `edge ${label}: first_seen`, name);
    if (firstSeen > lastSeen) fail(name, `edge ${label}: first_seen after last_seen`);

    edges.push({
      src: from.entityId,
      kind: edgeKind(k, options.logons as number | undefined),
      dst: to.entityId,
      graph_version: graphVersion(triple.status),
      source: triple.sources[0],
      first_seen: firstSeen,
      last_seen: lastSeen,
    });
  }

  return { name, description, nodes: [...byId.values()], edges, skipped };
};

/** Reads a scenario bundled with the command, by name (`stolen-okta-session`). */
export const readBundledScenario = (name: string): unknown => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`not a bundled scenario name: "${name}"`);
  const url = new URL(`./scenarios/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
};
