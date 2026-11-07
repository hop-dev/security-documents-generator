import { type Rng } from './rng.ts';

// How many edges a source node gets, or how many logons an edge has (SPEC.md, profile).
// Every draw is rounded to a whole number and clipped at 0. `zero` is the share of
// sources with no edge at all; the rest draw from the distribution.

/** z for the 99th percentile of a standard normal. */
const Z99 = 2.326;

export type Distribution =
  | { dist: 'uniform'; min: number; max: number; zero: number }
  | { dist: 'normal'; mean: number; sd: number; zero: number }
  | { dist: 'lognormal'; median: number; p99: number; mu: number; sigma: number; zero: number };

const FIELDS = {
  uniform: ['min', 'max'],
  normal: ['mean', 'sd'],
  lognormal: ['median', 'p99'],
} as const;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export const parseDistribution = (raw: unknown, where: string): Distribution => {
  const fail = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('a distribution must be an object like { "dist": "lognormal", ... }');
  }
  const r = raw as Record<string, unknown>;
  const dist = r.dist;
  if (dist !== 'uniform' && dist !== 'normal' && dist !== 'lognormal') {
    return fail(`unknown dist ${JSON.stringify(dist)} (uniform, normal or lognormal)`);
  }
  for (const key of Object.keys(r)) {
    if (key !== 'dist' && key !== 'zero' && !(FIELDS[dist] as readonly string[]).includes(key)) {
      fail(`unknown field "${key}" for ${dist}`);
    }
  }
  const zero = r.zero ?? 0;
  if (!isNum(zero) || zero < 0 || zero > 1) fail('zero must be from 0 to 1');
  const z = zero as number;

  if (dist === 'uniform') {
    const { min, max } = r;
    if (!isNum(min) || !isNum(max) || min < 0 || min > max) fail('uniform needs 0 <= min <= max');
    return { dist, min: min as number, max: max as number, zero: z };
  }
  if (dist === 'normal') {
    const { mean, sd } = r;
    if (!isNum(mean) || !isNum(sd) || sd < 0) fail('normal needs mean and sd (sd >= 0)');
    return { dist, mean: mean as number, sd: sd as number, zero: z };
  }
  const { median, p99 } = r;
  if (!isNum(median) || !isNum(p99) || median <= 0 || p99 < median) {
    return fail('lognormal needs 0 < median <= p99');
  }
  const mu = Math.log(median);
  return { dist, median, p99, mu, sigma: (Math.log(p99) - mu) / Z99, zero: z };
};

export const drawCount = (d: Distribution, rng: Rng): number => {
  if (d.zero > 0 && rng.next() < d.zero) return 0;
  let x: number;
  if (d.dist === 'uniform') return rng.int(Math.round(d.min), Math.round(d.max));
  if (d.dist === 'normal') x = d.mean + d.sd * rng.normal();
  else x = Math.exp(d.mu + d.sigma * rng.normal());
  return Math.max(0, Math.round(x));
};

/** The expected draw (before rounding), for the size estimate. */
export const meanCount = (d: Distribution): number => {
  const m =
    d.dist === 'uniform'
      ? (d.min + d.max) / 2
      : d.dist === 'normal'
        ? Math.max(0, d.mean)
        : Math.exp(d.mu + (d.sigma * d.sigma) / 2);
  return (1 - d.zero) * m;
};
