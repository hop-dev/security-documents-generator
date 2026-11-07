# Identity Access Graph Commands

Generate synthetic identity access graphs in the Entity Store: who can reach what, through which accounts, groups, roles and hosts. Two sources:

- **A random company** (`generate-identity-access-graph`): employees with Okta and AD accounts, laptops and servers, groups, AWS roles, buckets, keys and more, linked by edges drawn from a profile. Scales from a few hundred to millions of nodes.
- **A hand-written scenario** (`load-identity-access-scenario`): a small graph telling one story, such as a stolen Okta session reaching a customer-data bucket.

Every run is labeled with its seed (`labels.identity_graph_seed`) and removed with `clean-identity-access-graph`.

## Requirements

- Entity Store V2 installed in the target space. Install it from Kibana (Security → Entity analytics), or with `yarn start seed-latest-entities <name> --hosts 1 --init`. The commands check for `entities-latest-<space>` and stop before writing anything if it's missing.
- The Entity Store needs an Enterprise license (a trial works). Kibana's entity graph view needs Platinum or higher.

## Commands

### `generate-identity-access-graph` (`identity-graph`)

Generate a random company from a profile.

```bash
yarn start identity-graph --seed 7
yarn start identity-graph --seed 7 --employees 50000
yarn start identity-graph --seed 7 --profile ./my-profile.json
yarn start identity-graph --seed 7 --scenario stolen-okta-session
```

- `--profile <path>`: profile JSON (default: the bundled [`profiles/default.json`](profiles/default.json))
- `--employees <n>`: employees, overriding the profile's
- `--seed <seed>`: seed, overriding the profile's. The same seed gives the same graph.
- `--space <space>`: Kibana space (default: `default`)
- `--scenario <name|path>`: plant a scenario in the company (see [Scenarios](#scenarios))
- `--max-nodes <n>`: raise the size limit (default: 50,000,000)

Before writing anything the command prints its size estimate and refuses to start above the limit:

```
Estimated 82M nodes, 387M edges. Limit is 50M nodes; pass --max-nodes 90000000 to run anyway.
```

Employees are generated in chunks of 1,000 and written as they go, so memory stays flat. On a local single-node stack it writes about 28k documents a second (50k employees: 136k entities and 644k edges in 28 s).

### `load-identity-access-scenario`

Load one scenario alone, with no company around it.

```bash
yarn start load-identity-access-scenario stolen-okta-session --seed 42
yarn start load-identity-access-scenario ad-choke-points --seed 43
yarn start load-identity-access-scenario ./my-scenario.json --seed 44
```

- `<scenario>`: a bundled scenario name, or a path to a `.json` file
- `--seed <seed>` (required), `--space <space>` (default: `default`)

### `clean-identity-access-graph`

Delete one run's documents by seed, from both indices. It never drops an index.

```bash
yarn start clean-identity-access-graph --seed 7
```

- `--seed <seed>` (required), `--space <space>` (default: `default`)

### One seed, one run

Each seed holds one run per space. If the seed already has documents, both generating commands stop before writing:

```
Seed 7 already has 2,710 entities in space "default".
Run `clean-identity-access-graph --seed 7` first.
```

## What gets written

### Nodes: `entities-latest-<space>`

One Entity Store document per node, written directly with `_bulk` (`update` + `doc_as_upsert`, `pipeline=_none`), with `_id = sha256(entity.id)` as Kibana does. Each sets:

- `entity.id`: the id carries the seed (`user:alice@acme-s42.com@okta`, `arn:aws:iam::000000000042:role/OncallRole`), so runs never overlap.
- `entity.type`: a display type from Kibana's graph (`Identity`, `Host`, `Group`, `Access Management`, `Storage Bucket`, ...).
- `entity.EngineMetadata.Type`: `user`, `host` or `generic`.
- `entity.sub_type`: the node type (`okta_user`, `ad_group`, `role`, `bucket`, ...).
- `entity.namespace` for identities (`okta`, `active_directory`, `local`, `aws`), `entity.source`, `entity.name`, `@timestamp`, `entity.lifecycle`, `user.*` / `host.*` where they apply, and `asset.criticality` on crown jewels.
- A copy of the node's outgoing edges as `entity.relationships.<kind>.ids` (resolution as `entity.relationships.resolution.resolved_to`), so Kibana's entity graph and flyouts show them. The copy is capped at `arrays_cap` ids per kind (default 1,000); a capped kind is listed in `labels.identity_graph_truncated_kinds`.

Node types: `okta_user`, `okta_group`, `ad_acct`, `ad_group`, `local_acct`, `host`, `iam_user`, `role`, `bucket`, `key`, `secret`, `db` (a Redshift cluster), `compute` (an EC2 instance), `ext_acct` (an external AWS account), `saas` (an Okta app).

### Edges: `entities-edges-<space>`

Every edge is also one document in a hidden edges index beside the Entity Store, `.entities.v2.edges.<space>-00001` (alias `entities-edges-<space>`, lookup mode, strict mapping). It's the complete graph; the arrays copy on the nodes may be capped. A command creates the index if it's missing.

```json
{
  "src": "user:alice@acme-s42.com@okta",
  "kind": "member_of",
  "dst": "group:eng-oncall@acme-s42.com@okta",
  "graph_version": "future",
  "source": "okta-ea",
  "first_seen": "2026-11-05T00:00:00.000Z",
  "last_seen": "2026-11-05T00:00:00.000Z",
  "labels": { "identity_graph_seed": "42" }
}
```

- `_id = sha256(src|kind|dst|source)`.
- Edges always point in the attack direction: from what an attacker holds to what it gives them.
- `kind` is the relationship (`member_of`, `sso_to_role`, `can_assume`, `bucket_policy`, `local_admin`, `credentials_left`, ...). Logons follow Kibana's split: `accesses_frequently` above 4 logons, `accesses_infrequently` otherwise.
- `graph_version` is `current` for the kinds the Entity Store builds today (logons and resolution) and `future` for the rest. One run gives both graphs: `WHERE graph_version == "current"` is today's.
- Kibana's entity graph draws only its built-in kinds (`owns`, `resolution.resolved_to`, `accesses_*`, ...). The other kinds are stored and queryable with ES|QL.

### Walking the graph with ES|QL

```esql
// Forward one hop: what alice reaches
FROM entities-edges-default | WHERE src == "user:alice@acme-s42.com@okta" | KEEP kind, dst

// Backward one hop: who reaches the bucket
FROM entities-edges-default | WHERE dst == "arn:aws:s3:::acme-customer-pii-s42" | KEEP src, kind

// A hop with the target's name and criticality
FROM entities-edges-default
| WHERE src == "user:alice@acme-s42.com@okta"
| RENAME dst AS entity.id
| LOOKUP JOIN entities-latest-default ON entity.id
| KEEP kind, entity.id, entity.name, asset.criticality
```

### Manifest

Each run writes `data/identity_access_graph/<space>/<seed>/manifest.json` (gitignored): the resolved profile, the size estimate, counts by node type and edge kind, employees and identities, how many documents hit the arrays cap, the planted scenario and pathologies with their node ids. It records no expected answers: computing reach is the job of whatever is being tested against the data.

## Profile

A profile is one JSON file with every setting for a generated company. Start from [`profiles/default.json`](profiles/default.json); every number marked `"guess"` is a placeholder.

```json
{
  "seed": 42,
  "employees": 1000,
  "per_employee": { "okta_user": 1, "ad_acct": 1, "admin_acct": 0.05, "host": 0.13, "role": 0.05 },
  "edges": [
    {
      "triple": ["okta_user", "member of", "okta_group"],
      "per_source": { "dist": "lognormal", "median": 4, "p99": 25 },
      "targets": [
        { "fixed": "@Everyone" },
        { "same": "department" },
        { "random": true, "skew": 1.2 }
      ],
      "source": "guess"
    }
  ],
  "logon_count": { "dist": "lognormal", "median": 3, "p99": 40 },
  "arrays_cap": 1000,
  "pathologies": { "single_choke_link": { "on": true, "share_cut": 0.7 } },
  "blind_spots": {}
}
```

- **`employees` and `per_employee`**: employees are the one size input; every other node count is employees × its rate. `admin_acct` is extra AD admin accounts. Fractional rates are drawn per employee (0.13 hosts: a 13% chance of one).
- **`edges`**: one row per (source type, kind, target type). The profile fails to load if a row isn't an allowed edge.
- **`per_source`**: how many edges each source node gets, drawn from `uniform` (`min`, `max`), `normal` (`mean`, `sd`) or `lognormal` (`median`, `p99`). Draws are rounded and clipped at 0. `zero` (optional) is the share of sources with no edge of this kind at all.
- **`targets`**: pickers fill the drawn number in order. Each picker takes one target, and the last takes what's left:
  - `{ "fixed": "@Everyone" }`: a named company node
  - `{ "same": "department" }` or `{ "same": "tier" }`: a target sharing the source's department or host tier
  - `{ "random": true, "skew": 1.2 }`: random targets; `skew` above 0 makes a few targets popular (hubs). Always last.
  - `{ "via": [["bucket policy", "bucket"], ["encrypted with", "key"]] }`: targets reached by following other edges
  - `{ "own": true }`: the source's own node (a local account's host, a person's admin or local accounts)
- **`logon_count`**: logons per local account → host edge (decides frequent or infrequent).
- **`pathologies`** and **`blind_spots`**: see below.

Built-in groups (`Everyone`, `Domain Users`, `Domain Admins`, `Domain Computers`, `Enterprise Admins`) are never drawn at random: they come from `fixed` pickers or planted pathologies.

## Pathologies

Planted structures, the same at any company size, each switched on in the profile's `pathologies`. Their nodes stay out of the random pickers, so random edges never change them, and scenarios can link to them by `@` name.

| Profile key           | What it plants                                                                                                                                                                | `@` names                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `hub_past_cap`        | An Okta group with `members` company users                                                                                                                                    | `@All Staff`                           |
| `single_choke_link`   | `share_cut` × 20 users who reach Domain Admins only through one admin account (`da-choke`), whose credentials are left on a jump host they administer                         | `@da-choke`, `@Helpdesk`               |
| `msol_bypass`         | The other path users reach Domain Admins without `da-choke`: through a directory sync server that stores the `MSOL_` account's credentials, which can replicate Domain Admins | `@MSOL_`, `@AADC Admins`               |
| `indirect_role_chain` | 30 users in `chain-oncall` reach a crown-jewel bucket through `depth` role assumptions, though no policy names their first role                                               | `@chain-oncall`, `@customer-pii-vault` |
| `breakglass_role`     | A role that reads the crown-jewel bucket, assumable by 3 company roles                                                                                                        | `@BreakGlassAccountRole`               |
| `false_merge`         | An AWS session identity carrying an employee's email. Kibana's automated resolution links it to that employee's AD account, which is a known false merge                      |                                        |

Some patterns come from the edge rates instead and need no entry: ownership (`owns`), the same machine under two ids (`same machine`), credentials left on hosts, local admin through groups, and Okta → AD resolution by email (always on).

`blind_spots` (nodes whose own data was never collected) are not generated yet; a profile that sets them gets a warning.

## Scenarios

A scenario is a small hand-written graph. Bundled:

- [`stolen-okta-session`](scenarios/stolen-okta-session.json) (18 nodes, 19 edges): an Okta user reaching three crown jewels through groups, roles, a secret, a server and a Domain Admin's leftover credentials.
- [`ad-choke-points`](scenarios/ad-choke-points.json) (35 nodes, 35 edges): 20 users reach Domain Admins; one admin account's leftover credentials carry 14 of them (70%), and the other 6 keep a path through the directory sync account (`MSOL_`).

```json
{
  "name": "my-scenario",
  "description": "Alice's Okta session reaches the customer-data bucket.",
  "nodes": [
    { "id": "alice", "type": "okta_user", "name": "alice", "email": "alice@acme.com" },
    { "id": "laptop", "type": "host", "name": "alice-mbp" },
    { "id": "local_alice", "type": "local_acct", "name": "alice", "host": "laptop" },
    { "id": "r_oncall", "type": "role", "name": "OncallRole" },
    { "id": "bucket", "type": "bucket", "name": "customer-data", "criticality": "extreme_impact" }
  ],
  "edges": [
    ["alice", "member of", "@Everyone"],
    ["alice", "SSO to role", "r_oncall"],
    ["r_oncall", "bucket policy", "bucket"],
    ["local_alice", "logs on", "laptop", { "logons": 12 }]
  ]
}
```

- **Node fields:** `id` (local to the file), `type`, `name`; optional `email` (resolution matches on it), `criticality` (`low_impact` … `extreme_impact`), `blind_spot` (not supported by the writer yet), and `host` (required on local accounts: the id of its host node).
- **Edges:** `[from, kind, to]`, with an optional fourth element: `logons` (for `logs on`), `first_seen` / `last_seen` relative to the run (`"-3d"`). Every edge is checked against the allowed edges.
- **`@` names** link to company nodes, as targets only. Planted with `--scenario`, they resolve to the company's node; loaded alone, those edges are skipped. Referencing a pathology node (e.g. `@chain-oncall`) switches that pathology on. Names: `@Everyone`, `@Domain Users`, `@Domain Admins`, `@Domain Computers`, `@Enterprise Admins`, `@okta:<department>`, `@ad:<department>`, and the pathology names above. Departments: `Product & Engineering`, `Sales & Marketing`, `Customer Success`, `Operations`, `Executive`.
- **Scenario and company nodes never overlap.** A planted scenario can't create a node the company already has; the run stops before writing anything and names the node. Link to it with its `@` name instead. (`stolen-okta-session` defines its own `Domain Admins`, so it loads alone but isn't planted as is.)

## Tests

```bash
yarn test                 # unit tests, no stack needed
IAG_IT=1 yarn test        # also the tests that write to the stack in config.json
```

## Not yet

- Blind spots.
- GitHub nodes (`gh_user`, `gh_team`, `repo`): Kibana has no GitHub entity source yet, so they fail before anything is written.
- More bundled scenarios.
- Parallel bulk writes.
