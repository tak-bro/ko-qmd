import { describe, expect, test } from "vitest";
import {
  bootstrapStatistic,
  cohenKappa,
  flipRate,
  ndcgAt,
  weightedKappa,
} from "../src/bench/judge-metrics.js";

// Reference values computed by hand from the confusion-matrix formulas
// (kappa = (po - pe) / (1 - pe); quadratic weights (i - j)^2 / (k - 1)^2).
const A = [0, 1, 2, 3, 3, 2, 1, 0, 2, 3];
const B = [0, 2, 2, 3, 2, 2, 0, 0, 1, 3];

describe("cohenKappa", () => {
  test("perfect agreement is 1", () => {
    expect(cohenKappa([0, 1, 2, 3], [0, 1, 2, 3])).toBe(1);
  });

  test("agreement at chance level is 0", () => {
    expect(cohenKappa([0, 0, 1, 1], [0, 1, 0, 1])).toBeCloseTo(0, 12);
  });

  test("textbook 2x2 table gives 0.4", () => {
    // 20 yes/yes, 5 yes/no, 10 no/yes, 15 no/no: po 0.7, pe 0.5.
    const a = [...Array(25).fill(1), ...Array(25).fill(0)];
    const b = [...Array(20).fill(1), ...Array(5).fill(0), ...Array(10).fill(1), ...Array(15).fill(0)];
    expect(cohenKappa(a, b)).toBeCloseTo(0.4, 12);
  });

  test("four-grade example matches the reference value", () => {
    expect(cohenKappa(A, B)).toBeCloseTo(0.45945945945945943, 12);
  });

  test("one category used by both raters is undefined (NaN)", () => {
    expect(cohenKappa([2, 2, 2], [2, 2, 2])).toBeNaN();
  });

  test("rejects unequal lengths, empty input and grades outside 0-3", () => {
    expect(() => cohenKappa([0, 1], [0])).toThrow(/length/);
    expect(() => cohenKappa([], [])).toThrow(/empty/);
    expect(() => cohenKappa([0, 4], [0, 1])).toThrow(/grade/);
    expect(() => cohenKappa([0, 1.5], [0, 1])).toThrow(/grade/);
  });
});

describe("weightedKappa (quadratic)", () => {
  test("perfect agreement is 1", () => {
    expect(weightedKappa([0, 1, 2, 3], [0, 1, 2, 3])).toBe(1);
  });

  test("four-grade example matches the reference value", () => {
    expect(weightedKappa(A, B)).toBeCloseTo(0.84, 12);
  });

  test("near misses cost less than far misses", () => {
    const near = weightedKappa([0, 1, 2, 3], [1, 1, 2, 3]);
    const far = weightedKappa([0, 1, 2, 3], [3, 1, 2, 3]);
    expect(near).toBeGreaterThan(far);
  });
});

describe("ndcgAt", () => {
  test("ideal order scores 1", () => {
    expect(ndcgAt([3, 2, 1, 0], [3, 2, 1, 0])).toBe(1);
  });

  test("a swapped tail matches the reference value", () => {
    expect(ndcgAt([3, 2, 0, 1], [3, 2, 0, 1])).toBeCloseTo(0.992619504174702, 12);
  });

  test("reverse order scores below 1", () => {
    expect(ndcgAt([0, 1, 2, 3], [3, 2, 1, 0])).toBeLessThan(1);
  });

  test("ideal grades come from the pool, not only from the ranked list", () => {
    // The pool holds a grade-3 doc the ranking missed.
    expect(ndcgAt([1, 0], [3, 1, 0])).toBeLessThan(ndcgAt([1, 0], [1, 0]));
  });

  test("only the first k ranks count", () => {
    expect(ndcgAt([0, 3], [3, 0], 1)).toBe(0);
  });

  test("a pool with no relevant document is undefined (NaN)", () => {
    expect(ndcgAt([0, 0], [0, 0])).toBeNaN();
  });
});

describe("flipRate", () => {
  test("counts the share of grades that changed", () => {
    expect(flipRate([0, 1, 2, 3], [0, 1, 3, 0])).toBe(0.5);
  });

  test("rejects unequal lengths and empty input", () => {
    expect(() => flipRate([0], [0, 1])).toThrow(/length/);
    expect(() => flipRate([], [])).toThrow(/empty/);
  });
});

describe("bootstrapStatistic", () => {
  test("same seed gives the same interval, and it brackets the full-sample value", () => {
    const items = Array.from({ length: 40 }, (_, i) => i % 7);
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const a = bootstrapStatistic(items, mean, { iters: 2000, seed: 7 });
    const b = bootstrapStatistic(items, mean, { iters: 2000, seed: 7 });
    expect(a).toEqual(b);
    expect(a.value).toBeCloseTo(mean(items), 12);
    expect(a.lo).toBeLessThanOrEqual(a.value);
    expect(a.hi).toBeGreaterThanOrEqual(a.value);
    expect(a.undefinedDraws).toBe(0);
  });

  test("draws where the statistic is undefined are counted, not averaged in", () => {
    const items = [0, 0, 0, 1];
    const firstOrNaN = (xs: number[]) => (xs.includes(1) ? 1 : NaN);
    const r = bootstrapStatistic(items, firstOrNaN, { iters: 500, seed: 3 });
    expect(r.undefinedDraws).toBeGreaterThan(0);
    expect(r.lo).toBe(1);
    expect(r.hi).toBe(1);
  });

  test("empty input throws", () => {
    expect(() => bootstrapStatistic([], () => 0)).toThrow(/empty/);
  });
});
