import { createHash } from 'crypto';
import { employee, node, type Backbone, type CompanyNode } from './company.ts';
import { hostUuid } from './ids.ts';
import { type Profile } from './profile.ts';
import { type NodeType } from './triples.ts';

// Planted pathologies (SPEC.md section 4): named nodes placed on purpose, the same at any size.
// Names differ from the example scenarios' (OncallRole, BreakGlassRole, da-jlee, ...), so a
// scenario planted in the company never collides with them. Members come from the company:
// real employees join the planted groups, chosen by index, spread across the company.

/** `@` names a scenario can reference, and the pathology each one belongs to. */
export const PATHOLOGY_REFS: Record<string, string> = {
  '@All Staff': 'hub_past_cap',
  '@da-choke': 'single_choke_link',
  '@Helpdesk': 'single_choke_link',
  '@MSOL_': 'msol_bypass',
  '@AADC Admins': 'msol_bypass',
  '@chain-oncall': 'indirect_role_chain',
  '@BreakGlassAccountRole': 'breakglass_role',
};

/** Path users for the choke point and its bypass: example 3's 20. */
const PATH_USERS = 20;
/** Members of the chain group: example 1's eng-oncall has 31; 30 keeps it round. */
const CHAIN_MEMBERS = 30;
/** Company roles whose own permissions allow assuming the break-glass role. */
const BREAKGLASS_CALLERS = 3;

export interface PlantedEdge {
  from: { type: NodeType; entityId: string };
  kind: string;
  to: { type: NodeType; entityId: string };
}

/** Company employees join a planted group: `count` of them, spread by index. */
export interface Membership {
  pathology: string;
  /** okta_user, or ad_acct (the daily account, the one with an email). */
  from: 'okta_user' | 'ad_acct';
  to: CompanyNode;
  /** Which of the selected employees: ranks [first, last) of `of` spread slots. */
  of: number;
  first: number;
  last: number;
}

export interface Planted {
  nodes: CompanyNode[];
  refs: Map<string, CompanyNode>;
  edges: PlantedEdge[];
  memberships: Membership[];
  /** For the manifest: the node ids each planted pathology added. */
  report: Record<string, string[]>;
}

/** The pathologies a scenario's edges reference (referencing one switches it on). */
export const pathologiesReferenced = (rawScenario: unknown): string[] => {
  const edges = (rawScenario as { edges?: unknown })?.edges;
  const out = new Set<string>();
  for (const e of Array.isArray(edges) ? edges : []) {
    for (const v of Array.isArray(e) ? e : []) {
      if (typeof v === 'string' && PATHOLOGY_REFS[v]) out.add(PATHOLOGY_REFS[v]);
    }
  }
  return [...out];
};

/**
 * The rank of employee i among `of` employees spread evenly over the company, or -1 if not
 * selected. Offset by a salt so different pathologies pick different people.
 */
export const spreadRank = (i: number, of: number, employees: number, salt: string): number => {
  const m = Math.min(of, employees);
  const offset =
    parseInt(createHash('sha256').update(salt).digest('hex').slice(0, 8), 16) % employees;
  const j = (i + offset) % employees;
  const hit = Math.floor(((j + 1) * m) / employees) > Math.floor((j * m) / employees);
  return hit ? Math.floor(((j + 1) * m) / employees) - 1 : -1;
};

export const plantPathologies = (p: Profile, bb: Backbone): Planted => {
  const on = (name: string) => p.pathologies[name]?.on === true;
  const knob = (name: string, k: string, fallback: number) => {
    const v = p.pathologies[name]?.[k];
    return typeof v === 'number' ? v : fallback;
  };
  const nodes: CompanyNode[] = [];
  const refs = new Map<string, CompanyNode>();
  const edges: PlantedEdge[] = [];
  const memberships: Membership[] = [];
  const report: Record<string, string[]> = {};
  const plant = (pathology: string, n: CompanyNode, ref?: string) => {
    nodes.push(n);
    if (ref) refs.set(ref, n);
    (report[pathology] ??= []).push(n.entityId);
    return n;
  };
  const edge = (from: CompanyNode, kind: string, to: CompanyNode) => edges.push({ from, kind, to });
  const builtIn = (ref: string) => bb.byName.get(ref) as CompanyNode;
  const host = (name: string, tier: 0 | 1 | 2) =>
    node(p, { type: 'host', name, tier, host: { id: hostUuid(name, p.seed), name } });

  if (on('hub_past_cap')) {
    const hub = plant(
      'hub_past_cap',
      node(p, { type: 'okta_group', name: 'All Staff' }),
      '@All Staff',
    );
    const m = knob('hub_past_cap', 'members', 50_000);
    memberships.push({
      pathology: 'hub_past_cap',
      from: 'okta_user',
      to: hub,
      of: m,
      first: 0,
      last: m,
    });
  }

  const choke = on('single_choke_link');
  const bypass = on('msol_bypass');
  if (choke || bypass) {
    const da = builtIn('@Domain Admins');
    da.criticality = 'extreme_impact';
    const cut = choke ? Math.round(PATH_USERS * knob('single_choke_link', 'share_cut', 0.7)) : 0;
    if (choke) {
      const admin = plant(
        'single_choke_link',
        node(p, { type: 'ad_acct', name: 'da-choke' }),
        '@da-choke',
      );
      const jump = plant('single_choke_link', host('choke-jump-01', 1));
      const helpdesk = plant(
        'single_choke_link',
        node(p, { type: 'ad_group', name: 'Helpdesk', tier: 1 }),
        '@Helpdesk',
      );
      edge(admin, 'member of', da);
      edge(jump, 'credentials left', admin);
      edge(helpdesk, 'local admin', jump);
      memberships.push({
        pathology: 'single_choke_link',
        from: 'ad_acct',
        to: helpdesk,
        of: PATH_USERS,
        first: 0,
        last: cut,
      });
    }
    if (bypass) {
      const hex = createHash('sha256').update(`${p.seed}|MSOL_`).digest('hex').slice(0, 12);
      const msol = plant(
        'msol_bypass',
        node(p, { type: 'ad_acct', name: `MSOL_${hex}` }),
        '@MSOL_',
      );
      const aadc = plant('msol_bypass', host('aadc-01', 0));
      const admins = plant(
        'msol_bypass',
        node(p, { type: 'ad_group', name: 'AADC Admins', tier: 0 }),
        '@AADC Admins',
      );
      edge(aadc, 'stores credentials', msol);
      edge(msol, 'can replicate', da);
      edge(admins, 'local admin', aadc);
      memberships.push({
        pathology: 'msol_bypass',
        from: 'ad_acct',
        to: admins,
        of: PATH_USERS,
        first: cut,
        last: PATH_USERS,
      });
    }
  }

  let vault: CompanyNode | undefined;
  const theVault = (pathology: string) =>
    (vault ??= plant(
      pathology,
      { ...node(p, { type: 'bucket', name: 'customer-pii-vault' }), criticality: 'extreme_impact' },
      '@customer-pii-vault',
    ));

  if (on('indirect_role_chain')) {
    const depth = knob('indirect_role_chain', 'depth', 2);
    const group = plant(
      'indirect_role_chain',
      node(p, { type: 'okta_group', name: 'chain-oncall' }),
      '@chain-oncall',
    );
    const roles = Array.from({ length: depth + 1 }, (_, k) =>
      plant('indirect_role_chain', node(p, { type: 'role', name: `ChainRole-${k}` })),
    );
    edge(group, 'SSO to role', roles[0]);
    for (let k = 0; k < depth; k++) edge(roles[k], 'can assume', roles[k + 1]);
    edge(roles[depth], 'bucket policy', theVault('indirect_role_chain'));
    memberships.push({
      pathology: 'indirect_role_chain',
      from: 'okta_user',
      to: group,
      of: CHAIN_MEMBERS,
      first: 0,
      last: CHAIN_MEMBERS,
    });
  }

  if (on('breakglass_role')) {
    const bg = plant(
      'breakglass_role',
      node(p, { type: 'role', name: 'BreakGlassAccountRole' }),
      '@BreakGlassAccountRole',
    );
    edge(bg, 'bucket policy', theVault('breakglass_role'));
    // The trust names the whole account; only callers whose own permissions allow it count.
    for (const caller of bb.nodes.filter((n) => n.type === 'role').slice(0, BREAKGLASS_CALLERS)) {
      edge(caller, 'can assume', bg);
    }
  }

  if (on('false_merge')) {
    // An AWS session named after an employee's email: Kibana's resolution must not link it.
    const email = employee(p, 0).nodes.find((n) => n.type === 'okta_user')?.email;
    if (email) {
      plant('false_merge', {
        ...node(p, { type: 'iam_user', name: `assumed-role/BreakGlassAccountRole/${email}` }),
        email,
      });
    }
  }

  return { nodes, refs, edges, memberships, report };
};
