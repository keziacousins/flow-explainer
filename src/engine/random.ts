/** A source of numbers in [0, 1), like `Math.random`. */
export type Random = () => number;

/**
 * Seeded generator (mulberry32). Used so a deck, a run of traffic or a test behaves the
 * same every time; `?seed=<n>` in the URL makes a whole deck deterministic.
 */
export function makeRandom(seed: number): Random {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
