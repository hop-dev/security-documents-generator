import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { type Client } from '@elastic/elasticsearch';
import { getEsClient } from '../utils/indices.ts';
import { getDataDir } from '../../utils/data_paths.ts';
import { log } from '../../utils/logger.ts';
import { buildDocuments, DEFAULT_ARRAYS_CAP, type BuiltDocuments } from './documents.ts';
import { loadScenario, readBundledScenario, type EdgeDoc, type ScenarioNode } from './scenario.ts';
import { type CompanyNode } from './company.ts';
import { companyGenerator } from './edges.ts';
import { pathologiesReferenced } from './pathologies.ts';
import {
  checkSize,
  DEFAULT_MAX_NODES,
  describeSize,
  estimateSize,
  loadProfile,
  readBundledProfile,
} from './profile.ts';

// Writes to the Entity Store (SPEC.md sections 1, 3 and 6): nodes to entities-latest-<space>
// with update + doc_as_upsert, edges to entities-edges-<space>, both with plain _bulk.

const BULK_BATCH = 1000;

export const latestAlias = (space: string) => `entities-latest-${space}`;
export const edgesAlias = (space: string) => `entities-edges-${space}`;
export const edgesIndex = (space: string) => `.entities.v2.edges.${space}-00001`;

/**
 * Same index as dev/edges_index.sh: hidden, lookup mode, strict mapping. Replicas 0-1, so a
 * one-node cluster stays green and a bigger one keeps a copy.
 */
export const edgesIndexBody = (space: string) => ({
  settings: { 'index.hidden': true, 'index.mode': 'lookup', 'index.auto_expand_replicas': '0-1' },
  aliases: { [edgesAlias(space)]: { is_hidden: true } },
  mappings: {
    dynamic: 'strict' as const,
    properties: {
      src: { type: 'keyword' as const },
      kind: { type: 'keyword' as const },
      dst: { type: 'keyword' as const },
      graph_version: { type: 'keyword' as const },
      source: { type: 'keyword' as const },
      first_seen: { type: 'date' as const },
      last_seen: { type: 'date' as const },
      labels: { type: 'object' as const, dynamic: true },
    },
  },
});

const assertEntityStoreInstalled = async (es: Client, space: string) => {
  const exists = await es.indices.exists({ index: latestAlias(space), expand_wildcards: 'all' });
  if (!exists) {
    throw new Error(
      `The Entity Store isn't installed in space "${space}" (no ${latestAlias(space)}). Install it first; nothing was written.`,
    );
  }
};

/** One seed, one run, per space: refuse to write over an existing run. */
const assertSeedFree = async (es: Client, space: string, seed: number, scenario?: string) => {
  const { count } = await es.count({
    index: latestAlias(space),
    query: { term: { 'labels.identity_graph_seed': String(seed) } },
  });
  if (count === 0) return;
  const plant = scenario
    ? `, or plant the scenario\nwith \`generate-identity-access-graph --scenario ${scenario} --seed ${seed}\``
    : '';
  throw new Error(
    `Seed ${seed} already has ${count.toLocaleString('en-US')} entities in space "${space}".\n` +
      `Run \`clean-identity-access-graph --seed ${seed}\` first${plant}.`,
  );
};

const ensureEdgesIndex = async (es: Client, space: string) => {
  if (await es.indices.exists({ index: edgesIndex(space), expand_wildcards: 'all' })) return;
  await es.indices.create({ index: edgesIndex(space), ...edgesIndexBody(space) });
  log.info(`Created edges index ${edgesIndex(space)} (alias ${edgesAlias(space)})`);
};

/** Bulk-writes operations in batches and fails on any item error. */
const bulk = async (es: Client, operations: object[], pipeline?: string) => {
  for (let i = 0; i < operations.length; i += BULK_BATCH * 2) {
    const r = await es.bulk({
      operations: operations.slice(i, i + BULK_BATCH * 2),
      ...(pipeline && { pipeline }),
    });
    if (r.errors) {
      const failed = r.items
        .map((item) => Object.values(item)[0])
        .filter((x) => x?.error)
        .slice(0, 5)
        .map((x) => `${x?._id}: ${x?.error?.type} ${x?.error?.reason}`);
      throw new Error(`Bulk write failed:\n  ${failed.join('\n  ')}`);
    }
  }
};

const writeDocuments = async (es: Client, space: string, docs: BuiltDocuments) => {
  await bulk(
    es,
    docs.nodes.flatMap(({ _id, doc }) => [
      { update: { _index: latestAlias(space), _id } },
      { doc, doc_as_upsert: true },
    ]),
    '_none',
  );
  await bulk(
    es,
    docs.edges.flatMap(({ _id, doc }) => [{ index: { _index: edgesAlias(space), _id } }, doc]),
  );
};

const refresh = (es: Client, space: string) =>
  es.indices.refresh({ index: [latestAlias(space), edgesAlias(space)] });

const countBy = (values: string[], into: Record<string, number> = {}) => {
  for (const v of values) into[v] = (into[v] ?? 0) + 1;
  return into;
};

/** manifest.json in data/identity_access_graph/<space>/<seed>/ (gitignored). */
const writeManifest = (space: string, seed: number, manifest: object) => {
  const dir = path.join(getDataDir(), 'identity_access_graph', space, String(seed));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return file;
};

const readScenario = (nameOrPath: string): unknown =>
  nameOrPath.endsWith('.json') || nameOrPath.includes('/')
    ? JSON.parse(readFileSync(nameOrPath, 'utf8'))
    : readBundledScenario(nameOrPath);

export interface LoadScenarioParams {
  scenario: string;
  seed: number;
  space: string;
  now?: Date;
  arraysCap?: number;
}

/** load-identity-access-scenario: one hand-written scenario, alone, no company. */
export const loadIdentityAccessScenario = async ({
  scenario: nameOrPath,
  seed,
  space,
  now = new Date(),
  arraysCap = DEFAULT_ARRAYS_CAP,
}: LoadScenarioParams) => {
  // Everything that can fail without touching Elasticsearch runs first.
  const scenario = loadScenario(readScenario(nameOrPath), { seed, now });
  const docs = buildDocuments(scenario, { seed, now, arraysCap });

  const es = getEsClient();
  await assertEntityStoreInstalled(es, space);
  await assertSeedFree(es, space, seed, scenario.name);
  await ensureEdgesIndex(es, space);
  await writeDocuments(es, space, docs);
  await refresh(es, space);
  const manifestPath = writeManifest(space, seed, {
    command: 'load-identity-access-scenario',
    seed,
    space,
    run_time: now.toISOString(),
    arrays_cap: arraysCap,
    scenario: { name: scenario.name, description: scenario.description },
    counts: {
      nodes: countBy(scenario.nodes.map((n) => n.type)),
      edges: countBy(docs.edges.map((e) => e.doc.kind)),
    },
    arrays_cap_hits: docs.truncatedDocs,
    skipped_company_edges: scenario.skipped,
    blind_spot_nodes: scenario.nodes.filter((n) => n.blindSpot).map((n) => n.entityId),
  });

  for (const s of scenario.skipped) log.info(`Skipped (loaded alone, no company): ${s}`);
  log.info(
    `Loaded "${scenario.name}" (seed ${seed}) into space "${space}": ${docs.nodes.length} entities, ${docs.edges.length} edges. Manifest: ${manifestPath}`,
  );
  return {
    nodes: docs.nodes.length,
    edges: docs.edges.length,
    manifestPath,
    sampleNodeId: docs.nodes[0]?._id,
  };
};

export interface GenerateParams {
  /** Path to a profile JSON; the bundled default when absent. */
  profile?: string;
  employees?: number;
  seed?: number;
  space: string;
  maxNodes?: number;
  now?: Date;
  /** A scenario (bundled name or path) to plant in the company. */
  scenario?: string;
}

/** generate-identity-access-graph: a random company from a profile, written chunk by chunk. */
export const generateIdentityAccessGraph = async ({
  profile: profilePath,
  employees,
  seed,
  space,
  maxNodes = DEFAULT_MAX_NODES,
  now = new Date(),
  scenario: scenarioArg,
}: GenerateParams) => {
  // Everything that can fail without touching Elasticsearch runs first.
  if (profilePath && !existsSync(profilePath))
    throw new Error(`profile file not found: ${profilePath}`);
  const raw = (
    profilePath ? JSON.parse(readFileSync(profilePath, 'utf8')) : readBundledProfile('default')
  ) as Record<string, unknown>;
  // A scenario that references a pathology node (@chain-oncall, @MSOL_, ...) switches it on.
  const rawScenario = scenarioArg ? readScenario(scenarioArg) : undefined;
  const switchedOn = rawScenario ? pathologiesReferenced(rawScenario) : [];
  if (switchedOn.length) {
    const ps = { ...((raw.pathologies as Record<string, object>) ?? {}) };
    for (const name of switchedOn) ps[name] = { ...ps[name], on: true };
    raw.pathologies = ps;
  }
  const p = loadProfile(raw, { employees, seed });
  const estimate = estimateSize(p);
  log.info(describeSize(estimate));
  checkSize(estimate, maxNodes);
  const notYet = Object.values(p.blindSpots).some((v) => (v ?? 0) > 0) ? ['blind_spots'] : [];
  for (const x of notYet) log.warn(`Not generated yet (the profile turns it on): ${x}`);
  const gen = companyGenerator(p, now);

  // A planted scenario: its @ names resolve to company nodes. Company names carry an employee
  // index or a counter, so a hand-written name can't collide unless it copies that pattern;
  // every id is still checked, the backbone here and each chunk before it's written.
  const scenario = scenarioArg
    ? loadScenario(rawScenario, {
        seed: p.seed,
        now,
        company: new Map(
          [...gen.backbone.byName].map(([ref, n]) => [ref, { entityId: n.entityId, type: n.type }]),
        ),
      })
    : undefined;
  const scenarioIds = new Set(scenario?.nodes.map((n) => n.entityId));
  const checkCollisions = (nodes: CompanyNode[]) => {
    const hit = nodes.find((n) => scenarioIds.has(n.entityId));
    if (hit) {
      throw new Error(
        `scenario "${scenario?.name}" has a node with the same id as a generated one (${hit.entityId}); rename it in the scenario`,
      );
    }
  };
  checkCollisions(gen.backbone.nodes);
  // Build the scenario's documents now: anything they can't hold fails before any write.
  const scenarioDocs = scenario
    ? buildDocuments(scenario, { seed: p.seed, now, arraysCap: p.arraysCap })
    : undefined;

  const es = getEsClient();
  await assertEntityStoreInstalled(es, space);
  await assertSeedFree(es, space, p.seed);
  await ensureEdgesIndex(es, space);

  const counts = { nodes: {} as Record<string, number>, edges: {} as Record<string, number> };
  const capHits: Record<string, number> = {};
  let nodes = 0;
  let edges = 0;
  const write = async (
    part: { nodes: ScenarioNode[]; edges: EdgeDoc[] },
    built?: BuiltDocuments,
  ) => {
    const docs = built ?? buildDocuments(part, { seed: p.seed, now, arraysCap: p.arraysCap });
    await writeDocuments(es, space, docs);
    countBy(
      part.nodes.map((n) => n.type),
      counts.nodes,
    );
    countBy(
      part.edges.map((e) => e.kind),
      counts.edges,
    );
    for (const [k, v] of Object.entries(docs.truncatedDocs)) capHits[k] = (capHits[k] ?? 0) + v;
    nodes += docs.nodes.length;
    edges += docs.edges.length;
  };

  await write({ nodes: gen.backbone.nodes, edges: gen.backboneEdges });
  if (scenario) await write(scenario, scenarioDocs);
  for (let c = 0; c < gen.chunks; c++) {
    const chunk = gen.chunk(c);
    checkCollisions(chunk.nodes);
    await write(chunk);
    if ((c + 1) % 10 === 0 || c === gen.chunks - 1) {
      log.info(
        `Chunk ${c + 1}/${gen.chunks}: ${nodes.toLocaleString('en-US')} entities, ${edges.toLocaleString('en-US')} edges`,
      );
    }
  }
  await refresh(es, space);

  const manifestPath = writeManifest(space, p.seed, {
    command: 'generate-identity-access-graph',
    seed: p.seed,
    space,
    run_time: now.toISOString(),
    profile: { ...raw, seed: p.seed, employees: p.employees },
    estimate,
    ...(scenario && { scenario: { name: scenario.name, description: scenario.description } }),
    planted_pathologies: gen.planted,
    ...(switchedOn.length && { switched_on_by_scenario: switchedOn }),
    counts: {
      employees: p.employees,
      identities: ['okta_user', 'ad_acct', 'local_acct', 'iam_user', 'gh_user'].reduce(
        (n, t) => n + (counts.nodes[t] ?? 0),
        0,
      ),
      ...counts,
    },
    arrays_cap_hits: capHits,
    not_generated_yet: notYet,
  });
  log.info(
    `Generated seed ${p.seed} into space "${space}": ${nodes.toLocaleString('en-US')} entities, ${edges.toLocaleString('en-US')} edges. Manifest: ${manifestPath}`,
  );
  return { nodes, edges, manifestPath };
};

/** clean-identity-access-graph: deletes one run's documents by seed; never drops an index. */
export const cleanIdentityAccessGraph = async ({
  seed,
  space,
}: {
  seed: number;
  space: string;
}) => {
  const es = getEsClient();
  const query = { term: { 'labels.identity_graph_seed': String(seed) } };
  const del = async (index: string) =>
    (
      await es.deleteByQuery({
        index,
        query,
        refresh: true,
        ignore_unavailable: true,
        allow_no_indices: true,
        expand_wildcards: 'all',
      })
    ).deleted ?? 0;
  const result = { nodes: await del(latestAlias(space)), edges: await del(edgesAlias(space)) };
  log.info(
    `Cleaned seed ${seed} in space "${space}": ${result.nodes} entities, ${result.edges} edges.`,
  );
  return result;
};
