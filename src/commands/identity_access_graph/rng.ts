import { createHash } from 'crypto';

// Our own seeded random generator (CLAUDE.md: don't rely on faker's global seed).
// rngFor(seed, 'chunk', 3) always gives the same numbers, so any chunk, employee or row
// can be regenerated on its own. sfc32, seeded from sha256 of the parts.

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** A whole number from min to max, both included. */
  int(min: number, max: number): number;
  /** A standard normal draw (mean 0, sd 1). */
  normal(): number;
}

export const rngFor = (...parts: Array<string | number>): Rng => {
  const h = createHash('sha256').update(parts.join('|')).digest();
  let a = h.readUInt32LE(0);
  let b = h.readUInt32LE(4);
  let c = h.readUInt32LE(8);
  let d = h.readUInt32LE(12);
  const next = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Warm up, as sfc32 recommends.
  for (let i = 0; i < 12; i++) next();
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    normal: () => {
      const u = 1 - next(); // (0, 1], so log is finite
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
  };
};
