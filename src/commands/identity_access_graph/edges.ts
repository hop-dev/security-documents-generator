import {
  backbone,
  chunkCount,
  departmentOf,
  employee,
  employeeChunk,
  EMPLOYEE_TYPES,
  hostsOf,
  type Backbone,
  type CompanyNode,
} from './company.ts';
import { drawCount } from './distributions.ts';
import { edgeKind, entityId, graphVersion } from './ids.ts';
import { type EdgeRow, type Picker, type Profile } from './profile.ts';
import { rngFor, type Rng } from './rng.ts';
import { type EdgeDoc } from './scenario.ts';
import { findTriple, type NodeType } from './triples.ts';
import { plantPathologies, spreadRank, type PlantedEdge } from './pathologies.ts';

// The generated company's edges (SPEC.md section 1, Profile: targets).
// For each row and each source node: per_source draws how many edges (K); the pickers fill
// K in order, each taking one target and the last taking what's left. Every source draws
// from its own stream, so edges don't depend on how the run is chunked.
// Rows whose source is a backbone node run once, up front; rows whose source an employee
// owns run per chunk, with that chunk's nodes.

/** What a picker needs to know about a candidate target. */
interface Target {
  entityId: string;
  department?: string;
  tier?: number;
}

export interface ChunkOut {
  nodes: CompanyNode[];
  edges: EdgeDoc[];
}

export interface CompanyGenerator {
  profile: Profile;
  backbone: Backbone;
  /** Planted pathologies and the node ids each added (for the manifest). */
  planted: Record<string, string[]>;
  backboneEdges: EdgeDoc[];
  chunks: number;
  chunk(c: number): ChunkOut;
}

const isEmployeeType = (t: NodeType) => EMPLOYEE_TYPES.includes(t);
const label = (r: EdgeRow) => `${r.from} -[${r.kind}]-> ${r.to}`;

/** An index in [0, n), skewed toward 0 when skew > 0: a few targets get popular. */
const skewedIndex = (n: number, rng: Rng, skew: number) =>
  Math.min(n - 1, Math.floor(n * Math.pow(rng.next(), 1 + skew)));

/** Checks every row's pickers against this company before generating anything. */
const checkRows = (p: Profile, bb: Backbone) => {
  for (const r of p.edges) {
    const where = `profile: edges ${label(r)}`;
    for (const pk of r.targets) {
      if ('fixed' in pk) {
        const n = bb.byName.get(pk.fixed);
        if (!n) throw new Error(`${where}: fixed "${pk.fixed}" is not a company name`);
        if (n.type !== r.to) {
          throw new Error(`${where}: fixed "${pk.fixed}" is an ${n.type}, not an ${r.to}`);
        }
      }
      if ('own' in pk && !(isEmployeeType(r.from) && isEmployeeType(r.to))) {
        throw new Error(`${where}: own: a ${r.from} has no own ${r.to}`);
      }
      if ('via' in pk && (isEmployeeType(r.from) || pk.via.some((s) => isEmployeeType(s.type)))) {
        throw new Error(`${where}: via only follows shared (backbone) nodes`);
      }
    }
  }
};

export const companyGenerator = (p: Profile, now: Date): CompanyGenerator => {
  const ts = now.toISOString();
  const bb = backbone(p);
  // Random pools hold the generated backbone only: planted pathology nodes are reached through
  // their @ names, so random edges never change a planted structure.
  // Built-in groups (Everyone, Domain Users, Domain Admins, ...) are reached on purpose only,
  // through `fixed` or a planted pathology: drawn at random they made 5% of staff Domain Admins.
  // Department groups (@okta:…, @ad:…) stay in the pools.
  const builtIns = new Set(
    [...bb.byName].filter(([ref]) => !ref.includes(':')).map(([, n]) => n.entityId),
  );
  const byType = new Map<NodeType, Target[]>();
  for (const n of bb.nodes) {
    if (!builtIns.has(n.entityId)) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
  }
  const planted = plantPathologies(p, bb);
  bb.nodes.push(...planted.nodes);
  for (const [ref, n] of planted.refs) bb.byName.set(ref, n);
  checkRows(p, bb);

  // Hosts are listed once (cheap: no names drawn), so `same: tier` can find rare tiers.
  let hostList: Target[] | undefined;
  const hosts = (): Target[] => {
    if (!hostList) {
      hostList = [];
      for (let j = 0; j < p.employees; j++) {
        const department = departmentOf(p, j);
        for (const h of hostsOf(p, j)) {
          hostList.push({
            entityId: entityId({ type: 'host', name: h.name }, p.seed),
            tier: h.tier,
            department,
          });
        }
      }
    }
    return hostList;
  };
  const listOf = (t: NodeType): Target[] | undefined =>
    t === 'host' ? hosts() : isEmployeeType(t) ? undefined : (byType.get(t) ?? []);

  // A small cache of rebuilt employees: targets owned by employees are found by index.
  const cache = new Map<number, CompanyNode[]>();
  const nodesOf = (j: number): CompanyNode[] => {
    let n = cache.get(j);
    if (!n) {
      if (cache.size > 5000) cache.clear();
      n = employee(p, j).nodes;
      cache.set(j, n);
    }
    return n;
  };

  // Backbone edges by source and model kind, for `via`.
  const adjacency = new Map<string, Map<string, string[]>>();

  const targetsFor = (r: EdgeRow, src: CompanyNode, k: number, rng: Rng): string[] => {
    const chosen: string[] = [];
    const seen = new Set<string>([src.entityId]);
    const add = (id: string) => {
      if (chosen.length >= k || seen.has(id)) return;
      seen.add(id);
      chosen.push(id);
    };
    const takeFrom = (
      list: Target[],
      want: number,
      skew: number,
      keep?: (t: Target) => boolean,
    ) => {
      const pool = keep ? list.filter(keep) : list;
      const goal = Math.min(k, chosen.length + want);
      if (pool.length <= want) {
        for (const t of pool) add(t.entityId);
        return;
      }
      for (let tries = 0; chosen.length < goal && tries < want * 20; tries++) {
        add(pool[skewedIndex(pool.length, rng, skew)].entityId);
      }
      for (
        let i = rng.int(0, pool.length - 1), n = 0;
        chosen.length < goal && n < pool.length;
        n++
      ) {
        add(pool[(i + n) % pool.length].entityId);
      }
    };
    const sampleEmployees = (want: number, skew: number, keep?: (t: Target) => boolean) => {
      const goal = Math.min(k, chosen.length + want);
      for (let tries = 0; chosen.length < goal && tries < want * 50; tries++) {
        const found = nodesOf(skewedIndex(p.employees, rng, skew)).filter(
          (n) => n.type === r.to && !seen.has(n.entityId) && (!keep || keep(n)),
        );
        if (found.length) add(found[rng.int(0, found.length - 1)].entityId);
      }
    };
    const fill = (want: number, skew: number, keep?: (t: Target) => boolean) => {
      const list = listOf(r.to);
      if (list) takeFrom(list, want, skew, keep);
      else sampleEmployees(want, skew, keep);
    };
    const own = (): string[] => {
      if (r.from === 'local_acct' && r.to === 'host')
        return src.host ? [`host:${src.host.id}`] : [];
      return nodesOf(src.slot as number)
        .filter((n) => n.type === r.to && n.entityId !== src.entityId)
        .filter((n) => !(r.from === 'ad_acct' && r.to === 'ad_acct') || (!src.email && n.email))
        .map((n) => n.entityId);
    };
    const via = (steps: Array<{ kind: string }>): Target[] => {
      let frontier = [src.entityId];
      for (const s of steps) {
        frontier = [...new Set(frontier.flatMap((id) => adjacency.get(id)?.get(s.kind) ?? []))];
      }
      return frontier.map((entityId) => ({ entityId }));
    };

    r.targets.forEach((pk: Picker, i) => {
      const left = k - chosen.length;
      if (left <= 0) return;
      const want = i === r.targets.length - 1 ? left : 1;
      if ('fixed' in pk) add((bb.byName.get(pk.fixed) as CompanyNode).entityId);
      else if ('own' in pk) own().slice(0, want).forEach(add);
      else if ('via' in pk) takeFrom(via(pk.via), want, 0);
      else if ('same' in pk) {
        const v = src[pk.same];
        if (v !== undefined) fill(want, 0, (t) => t[pk.same] === v);
      } else fill(want, pk.skew);
    });
    return chosen;
  };

  const edgesFor = (r: EdgeRow, src: CompanyNode, out: EdgeDoc[]) => {
    const rng = rngFor(p.seed, 'edges', r.from, r.kind, r.to, src.entityId);
    const k = drawCount(r.perSource, rng);
    if (k === 0) return;
    for (const dst of targetsFor(r, src, k, rng)) {
      const logons = r.kind === 'logs on' ? Math.max(1, drawCount(p.logonCount, rng)) : undefined;
      out.push({
        src: src.entityId,
        kind: edgeKind(r.kind, logons),
        dst,
        graph_version: graphVersion(r.triple.status),
        source: r.triple.sources[0],
        first_seen: ts,
        last_seen: ts,
      });
      if (!isEmployeeType(r.from)) {
        const byKind = adjacency.get(src.entityId) ?? new Map<string, string[]>();
        adjacency.set(src.entityId, byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), dst]));
      }
    }
  };

  /** An edge the generator writes by rule (pathologies, resolution), checked like any other. */
  const ruleEdge = (from: PlantedEdge['from'], kind: string, to: PlantedEdge['to']): EdgeDoc => {
    const t = findTriple(from.type, kind, to.type);
    if (!t) throw new Error(`internal: ${from.type} -[${kind}]-> ${to.type} is not a triple`);
    return {
      src: from.entityId,
      kind: edgeKind(kind),
      dst: to.entityId,
      graph_version: graphVersion(t.status),
      source: t.sources[0],
      first_seen: ts,
      last_seen: ts,
    };
  };

  // Kibana's automated resolution (SPEC.md pathology 11): an identity in another directory
  // with the same single email (lowercased) resolves to the AD account. Not a profile row:
  // Kibana always does it. Accounts without an email (admin accounts) never resolve.
  const resolutions = (nodes: CompanyNode[]): EdgeDoc[] => {
    const ad = new Map<string, CompanyNode>();
    for (const n of nodes) if (n.type === 'ad_acct' && n.email) ad.set(n.email.toLowerCase(), n);
    const out: EdgeDoc[] = [];
    for (const n of nodes) {
      const to = n.type !== 'ad_acct' && n.email ? ad.get(n.email.toLowerCase()) : undefined;
      if (to && findTriple(n.type, 'resolved to', 'ad_acct'))
        out.push(ruleEdge(n, 'resolved to', to));
    }
    return out;
  };

  const backboneEdges: EdgeDoc[] = [];
  for (const r of p.edges) {
    if (isEmployeeType(r.from)) continue;
    for (const src of bb.nodes) {
      if (src.type === r.from && !planted.nodes.includes(src)) edgesFor(r, src, backboneEdges);
    }
  }
  for (const e of planted.edges) backboneEdges.push(ruleEdge(e.from, e.kind, e.to));

  /** Company employees in this chunk who join planted groups. */
  const membershipEdges = (nodes: CompanyNode[]): EdgeDoc[] => {
    const out: EdgeDoc[] = [];
    for (const m of planted.memberships) {
      for (const n of nodes) {
        if (n.type !== m.from || (m.from === 'ad_acct' && !n.email)) continue;
        const rank = spreadRank(n.slot as number, m.of, p.employees, `${p.seed}|${m.pathology}`);
        if (rank >= m.first && rank < m.last) out.push(ruleEdge(n, 'member of', m.to));
      }
    }
    return out;
  };

  return {
    profile: p,
    backbone: bb,
    planted: planted.report,
    backboneEdges,
    chunks: chunkCount(p),
    chunk: (c: number) => {
      const nodes = employeeChunk(p, c);
      const edges: EdgeDoc[] = [];
      for (const r of p.edges) {
        if (!isEmployeeType(r.from)) continue;
        for (const src of nodes) if (src.type === r.from) edgesFor(r, src, edges);
      }
      edges.push(...resolutions(nodes), ...membershipEdges(nodes));
      return { nodes, edges };
    },
  };
};
