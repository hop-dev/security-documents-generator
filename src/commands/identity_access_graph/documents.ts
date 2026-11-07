import { createHash } from 'crypto';
import { type NodeType } from './triples.ts';
import { type EdgeDoc, type LoadedScenario, type ScenarioNode } from './scenario.ts';

// Turns a loaded graph into Elasticsearch documents (SPEC.md sections 2, 3 and 6):
// Entity Store nodes for the latest index, plus one document per edge for the edges index.

export const DEFAULT_ARRAYS_CAP = 1000;

const RESOLVED_TO = 'resolution.resolved_to';

interface NodeInfo {
  /** entity.type: a name from the Kibana graph's icon list. */
  display: string;
  /** entity.EngineMetadata.Type: one of Kibana's four definitions. */
  definition: 'user' | 'host' | 'generic';
  /** entity.namespace, for identities only. */
  namespace?: string;
  /** entity.source, as Kibana's own documents spell it (seen on 9.5.6). */
  source?: string;
}

// SPEC.md section 2, node table. `source` is filled only where the exact string is confirmed.
const NODE_INFO: Record<NodeType, NodeInfo> = {
  okta_user: {
    display: 'Identity',
    definition: 'user',
    namespace: 'okta',
    source: 'entityanalytics_okta',
  },
  ad_acct: {
    display: 'Identity',
    definition: 'user',
    namespace: 'active_directory',
    source: 'entityanalytics_ad',
  },
  local_acct: { display: 'Identity', definition: 'user', namespace: 'local', source: 'endpoint' },
  iam_user: {
    display: 'Identity',
    definition: 'user',
    namespace: 'aws',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  // GitHub: a stand-in source. Kibana has no GitHub entity source yet; `github` is the name of
  // Elastic's GitHub integration (ENTITY-STORE-CHANGES item 7).
  gh_user: { display: 'Identity', definition: 'user', namespace: 'github', source: 'github' },
  host: { display: 'Host', definition: 'host', source: 'endpoint' },
  okta_group: { display: 'Group', definition: 'generic', source: 'entityanalytics_okta' },
  ad_group: { display: 'Group', definition: 'generic', source: 'entityanalytics_ad' },
  iam_group: {
    display: 'Group',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  gh_team: { display: 'Group', definition: 'generic', source: 'github' },
  role: {
    display: 'Access Management',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  bucket: {
    display: 'Storage Bucket',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  key: {
    display: 'Encryption Keys',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  secret: {
    display: 'Secret',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  db: {
    display: 'Database',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  ap: {
    display: 'Storage',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  compute: {
    display: 'Virtual Machine',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  ext_acct: {
    display: 'Subscription',
    definition: 'generic',
    source: 'cloud_asset_inventory.asset_inventory',
  },
  repo: { display: 'Repository', definition: 'generic', source: 'github' },
  saas: {
    display: 'Application (Desktop or Web App)',
    definition: 'generic',
    source: 'entityanalytics_okta',
  },
};

/** False for node types Kibana has no entity.source for yet (GitHub). */
export const hasEntitySource = (type: NodeType): boolean => NODE_INFO[type].source !== undefined;

type Relationships = Record<string, { ids: string[] } | { resolved_to: string }>;

export interface EntityDoc {
  '@timestamp': string;
  entity: {
    id: string;
    name: string;
    type: string;
    sub_type: NodeType;
    namespace?: string;
    source: string;
    EngineMetadata: { Type: NodeInfo['definition']; UntypedId: string };
    lifecycle: { first_seen: string; last_seen: string };
    relationships?: Relationships;
  };
  user?: { name: string; email?: string };
  host?: { id: string; name?: string };
  asset?: { criticality: string };
  labels: { identity_graph_seed: string; identity_graph_truncated_kinds?: string[] };
}

export interface EdgeIndexDoc extends EdgeDoc {
  labels: { identity_graph_seed: string };
}

export interface BuiltDocuments {
  nodes: Array<{ _id: string; doc: EntityDoc }>;
  edges: Array<{ _id: string; doc: EdgeIndexDoc }>;
  /** How many node documents hit the arrays cap, per kind (for the manifest). */
  truncatedDocs: Record<string, number>;
}

export interface BuildOptions {
  seed: number;
  now: Date;
  arraysCap: number;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Kibana's rule: the latest index `_id` is sha256 of the full entity.id. */
export const entityDocId = (entityId: string): string => sha256(entityId);

export const edgeDocId = (e: Pick<EdgeDoc, 'src' | 'kind' | 'dst' | 'source'>): string =>
  sha256(`${e.src}|${e.kind}|${e.dst}|${e.source}`);

/**
 * The ids arrays copy for Kibana's UI, per source entity: attack direction, at most
 * `cap` ids per kind, capped kinds listed. Resolution is a single value, as Kibana stores it.
 * `cap` 0 writes no copy.
 */
export const relationshipsCopy = (
  edges: readonly EdgeDoc[],
  cap: number,
): Map<string, { relationships: Relationships; truncated: string[] }> => {
  const out = new Map<string, { relationships: Relationships; truncated: string[] }>();
  if (cap === 0) return out;
  const targets = new Map<string, Map<string, string[]>>();
  for (const e of edges) {
    const byKind = targets.get(e.src) ?? new Map<string, string[]>();
    targets.set(e.src, byKind);
    const list = byKind.get(e.kind) ?? [];
    byKind.set(e.kind, list);
    if (!list.includes(e.dst)) list.push(e.dst);
  }
  for (const [src, byKind] of targets) {
    const relationships: Relationships = {};
    const truncated: string[] = [];
    for (const [kind, ids] of byKind) {
      const limit = kind === RESOLVED_TO ? 1 : cap;
      if (ids.length > limit) truncated.push(kind);
      if (kind === RESOLVED_TO) relationships.resolution = { resolved_to: ids[0] };
      else relationships[kind] = { ids: ids.slice(0, limit) };
    }
    out.set(src, { relationships, truncated });
  }
  return out;
};

const untypedId = (node: ScenarioNode, definition: NodeInfo['definition']): string =>
  definition === 'generic' ? node.entityId : node.entityId.slice(node.entityId.indexOf(':') + 1);

export const buildDocuments = (
  graph: Pick<LoadedScenario, 'nodes' | 'edges'>,
  { seed, now, arraysCap }: BuildOptions,
): BuiltDocuments => {
  if (!Number.isInteger(arraysCap) || arraysCap < 0) {
    throw new Error(`arrays_cap must be a whole number of 0 or more, got ${arraysCap}`);
  }
  const ts = now.toISOString();
  const seedLabel = String(seed);
  const copy = relationshipsCopy(graph.edges, arraysCap);
  const truncatedDocs: Record<string, number> = {};

  const nodes = graph.nodes.map((node) => {
    if (node.blindSpot) {
      throw new Error(`node "${node.localId}": blind_spot is not supported yet by the writer`);
    }
    const info = NODE_INFO[node.type];
    if (!info.source) throw new Error(`no entity.source yet for node type ${node.type}`);
    const rel = copy.get(node.entityId);
    for (const kind of rel?.truncated ?? []) truncatedDocs[kind] = (truncatedDocs[kind] ?? 0) + 1;

    const doc: EntityDoc = {
      '@timestamp': ts,
      entity: {
        id: node.entityId,
        // Kibana names a local account after its host too: alice@alice-mbp.
        name: node.type === 'local_acct' ? `${node.name}@${node.host?.name}` : node.name,
        type: node.type === 'compute' && node.service === 'lambda' ? 'FaaS' : info.display,
        sub_type: node.type,
        ...(info.namespace && { namespace: info.namespace }),
        source: info.source,
        EngineMetadata: { Type: info.definition, UntypedId: untypedId(node, info.definition) },
        lifecycle: { first_seen: ts, last_seen: ts },
        ...(rel && { relationships: rel.relationships }),
      },
      ...(info.definition === 'user' && {
        user: { name: node.name, ...(node.email && { email: node.email }) },
      }),
      ...(node.type === 'host' && node.host && { host: node.host }),
      ...(node.type === 'local_acct' && node.host && { host: { id: node.host.id } }),
      ...(node.criticality && { asset: { criticality: node.criticality } }),
      labels: {
        identity_graph_seed: seedLabel,
        ...(rel?.truncated.length && { identity_graph_truncated_kinds: rel.truncated }),
      },
    };
    return { _id: entityDocId(node.entityId), doc };
  });

  const edges = graph.edges.map((e) => ({
    _id: edgeDocId(e),
    doc: { ...e, labels: { identity_graph_seed: seedLabel } },
  }));

  return { nodes, edges, truncatedDocs };
};
