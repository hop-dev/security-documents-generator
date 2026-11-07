import { type Command } from 'commander';
import { type CommandModule } from '../types.ts';
import { parseIntBase10, wrapAction } from '../utils/cli_utils.ts';
import {
  cleanIdentityAccessGraph,
  generateIdentityAccessGraph,
  loadIdentityAccessScenario,
} from './writer.ts';
import { DEFAULT_MAX_NODES } from './profile.ts';

export const identityAccessGraphCommands: CommandModule = {
  register(program: Command) {
    program
      .command('generate-identity-access-graph')
      .alias('identity-graph')
      .description(
        'Generate a random company identity access graph from a profile into the Entity Store and the edges index',
      )
      .option('--profile <path>', 'profile JSON (default: the bundled default profile)')
      .option('--employees <n>', "employees (overrides the profile's)", parseIntBase10)
      .option(
        '--seed <seed>',
        "seed (overrides the profile's); one seed holds one run per space",
        parseIntBase10,
      )
      .option('--space <space>', 'Kibana space', 'default')
      .option('--scenario <scenario>', 'plant a scenario (bundled name or path to a .json file)')
      .option(
        '--max-nodes <n>',
        `refuse to start above this many estimated nodes (default ${DEFAULT_MAX_NODES})`,
        parseIntBase10,
      )
      .action(
        wrapAction(
          async (options: {
            profile?: string;
            employees?: number;
            seed?: number;
            space: string;
            maxNodes?: number;
            scenario?: string;
          }) => {
            await generateIdentityAccessGraph(options);
          },
        ),
      );

    program
      .command('load-identity-access-scenario')
      .argument(
        '<scenario>',
        'bundled scenario name (e.g. stolen-okta-session) or path to a .json file',
      )
      .description(
        'Load one hand-written identity access scenario alone (no company) into the Entity Store and the edges index',
      )
      .requiredOption(
        '--seed <seed>',
        'seed: goes into every id; one seed holds one run per space',
        parseIntBase10,
      )
      .option('--space <space>', 'Kibana space', 'default')
      .action(
        wrapAction(async (scenario: string, options: { seed: number; space: string }) => {
          await loadIdentityAccessScenario({ scenario, seed: options.seed, space: options.space });
        }),
      );

    program
      .command('clean-identity-access-graph')
      .description(
        "Delete one identity access graph run's documents by seed, from the latest and edges indices (never drops an index)",
      )
      .requiredOption('--seed <seed>', 'seed of the run to delete', parseIntBase10)
      .option('--space <space>', 'Kibana space', 'default')
      .action(
        wrapAction(async (options: { seed: number; space: string }) => {
          await cleanIdentityAccessGraph({ seed: options.seed, space: options.space });
        }),
      );
  },
};
