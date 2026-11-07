import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rngFor } from './rng.ts';
import { drawCount, meanCount, parseDistribution } from './distributions.ts';

const draws = (spec: unknown, n: number, ...seed: Array<string | number>) => {
  const d = parseDistribution(spec, 'test');
  const rng = rngFor(...seed);
  return Array.from({ length: n }, () => drawCount(d, rng)).sort((a, b) => a - b);
};
const q = (xs: number[], p: number) => xs[Math.floor(p * (xs.length - 1))];
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('the random generator is ours and seeded: same parts, same numbers', () => {
  const a = rngFor(42, 'chunk', 3);
  const b = rngFor(42, 'chunk', 3);
  const c = rngFor(42, 'chunk', 4);
  const xs = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(
    xs,
    Array.from({ length: 5 }, () => b.next()),
  );
  assert.notDeepEqual(
    xs,
    Array.from({ length: 5 }, () => c.next()),
  );
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  const ints = Array.from({ length: 2000 }, () => a.int(1, 3));
  assert.deepEqual([...new Set(ints)].sort(), [1, 2, 3]);
});

test('uniform: whole numbers from min to max', () => {
  const xs = draws({ dist: 'uniform', min: 1, max: 3 }, 5000, 1);
  assert.equal(xs[0], 1);
  assert.equal(xs[xs.length - 1], 3);
  assert.ok(Math.abs(mean(xs) - 2) < 0.05);
});

test('normal: rounded, clipped at 0', () => {
  const xs = draws({ dist: 'normal', mean: 6, sd: 2 }, 20000, 2);
  assert.ok(Math.abs(mean(xs) - 6) < 0.1);
  assert.ok(xs[0] >= 0);
  const low = draws({ dist: 'normal', mean: 0, sd: 3 }, 2000, 3);
  assert.ok(low.every((x) => x >= 0 && Number.isInteger(x)));
});

test('lognormal: hits the median and p99 it was given', () => {
  const xs = draws({ dist: 'lognormal', median: 4, p99: 25 }, 50000, 4);
  assert.equal(q(xs, 0.5), 4);
  assert.ok(Math.abs(q(xs, 0.99) - 25) <= 2, `p99 ${q(xs, 0.99)}`);
  assert.equal(q(xs, 0.25), 2);
  assert.equal(q(xs, 0.75), 7);
});

test('zero: that share of sources gets no edge, the rest draw', () => {
  const xs = draws({ dist: 'lognormal', median: 1, p99: 5, zero: 0.8 }, 20000, 5);
  const zeros = xs.filter((x) => x === 0).length / xs.length;
  // 80% from zero, plus the lognormal's own rounding to 0 among the other 20%.
  assert.ok(zeros > 0.8 && zeros < 0.86, `zeros ${zeros}`);
});

test('meanCount: the expected draw, used by the size estimate', () => {
  assert.equal(meanCount(parseDistribution({ dist: 'uniform', min: 1, max: 3 }, 't')), 2);
  assert.equal(
    meanCount(parseDistribution({ dist: 'uniform', min: 1, max: 3, zero: 0.5 }, 't')),
    1,
  );
  const ln = meanCount(parseDistribution({ dist: 'lognormal', median: 4, p99: 25 }, 't'));
  assert.ok(Math.abs(ln - 5.46) < 0.01, `${ln}`);
});

test('bad distributions fail, naming where they are', () => {
  const bad: Array<[unknown, RegExp]> = [
    [{ dist: 'poisson', mean: 3 }, /row X: unknown dist "poisson"/],
    [{ dist: 'uniform', min: 3, max: 1 }, /row X: uniform needs 0 <= min <= max/],
    [{ dist: 'normal', mean: 3 }, /row X: normal needs mean and sd/],
    [{ dist: 'lognormal', median: 4, p99: 2 }, /row X: lognormal needs 0 < median <= p99/],
    [{ dist: 'uniform', min: 1, max: 2, zero: 1.5 }, /row X: zero must be from 0 to 1/],
    [{ dist: 'uniform', min: 1, max: 2, mean: 1 }, /row X: unknown field "mean" for uniform/],
  ];
  for (const [spec, re] of bad) assert.throws(() => parseDistribution(spec, 'row X'), re);
});
