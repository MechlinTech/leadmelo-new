import test from 'node:test';
import assert from 'node:assert/strict';
import { normalCdf, twoProportionTest, chiSquareSurvival, sampleRatioMismatch, judge } from '../lib/experiments/stats.ts';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const arm = (label, isControl, sent, primary, unsubscribed = 0, weight = 1) => ({ variantId: label, label, isControl, weight, sent, primary, unsubscribed });

test('normal CDF and chi-square survival match published reference values', () => {
  near(normalCdf(0), 0.5, 1e-7); near(normalCdf(1.96), 0.9750021, 1e-6); near(normalCdf(-1.96), 0.0249979, 1e-6); near(normalCdf(1), 0.8413447, 1e-6);
  near(chiSquareSurvival(3.841459, 1), 0.05, 1e-4); near(chiSquareSurvival(5.991465, 2), 0.05, 1e-6);
  near(chiSquareSurvival(7.814728, 3), 0.05, 1e-4); near(chiSquareSurvival(9.487729, 4), 0.05, 1e-4); near(chiSquareSurvival(18.307038, 10), 0.05, 1e-4);
});
test('two-proportion z-test matches a hand-computed case', () => {
  // 50/500 vs 80/500: pooled 0.13, se = sqrt(.13*.87*(2/500)) = 0.021270, z = 0.06/0.021270 = 2.8208
  const r = twoProportionTest(50, 500, 80, 500);
  near(r.z, 2.8208, 1e-3); near(r.p, 0.00479, 2e-4); near(r.diff, 0.06, 1e-12);
  assert.equal(twoProportionTest(0, 100, 0, 100).p, 1); assert.equal(twoProportionTest(5, 0, 5, 10).p, 1);
  near(twoProportionTest(50, 500, 50, 500).p, 1, 1e-6); // erf approximation is accurate to ~1.5e-7
});
test('sample ratio mismatch flags broken assignment but not ordinary noise', () => {
  assert.ok(sampleRatioMismatch([700, 300], [1, 1]).p < 0.001);
  assert.ok(sampleRatioMismatch([510, 490], [1, 1]).p > 0.4);
  assert.ok(sampleRatioMismatch([250, 750], [1, 3]).p > 0.9, 'weights are respected');
});
test('judge refuses to pick a winner without enough data', () => {
  assert.equal(judge([arm('A', true, 99, 5), arm('B', false, 500, 60)], { minSample: 100 }).status, 'INSUFFICIENT_DATA');
  assert.equal(judge([arm('A', true, 500, 5)], { minSample: 100 }).status, 'INSUFFICIENT_DATA');
});
test('judge: real lift wins; small or noisy lift does not; corrected alpha applies with many variants', () => {
  const win = judge([arm('A', true, 500, 50), arm('B', false, 500, 80)], { minSample: 100 });
  assert.equal(win.status, 'WINNER'); assert.equal(win.winnerVariantId, 'B');
  assert.equal(judge([arm('A', true, 500, 50), arm('B', false, 500, 58)], { minSample: 100 }).status, 'NO_SIGNIFICANT_DIFFERENCE', 'p too large');
  assert.equal(judge([arm('A', true, 100000, 5000), arm('B', false, 100000, 5300)], { minSample: 100, minLift: 0.01 }).status, 'NO_SIGNIFICANT_DIFFERENCE', 'significant but under the minimum lift');
  // p about 0.02: passes alone but not with Bonferroni over 3 variants (alpha .0167)
  const single = judge([arm('A', true, 1000, 100), arm('B', false, 1000, 133)], { minSample: 100 });
  assert.equal(single.status, 'WINNER');
  const multi = judge([arm('A', true, 1000, 100), arm('B', false, 1000, 128), arm('C', false, 1000, 101), arm('D', false, 1000, 99)], { minSample: 100 });
  assert.equal(multi.status, 'NO_SIGNIFICANT_DIFFERENCE');
});
test('judge: unsubscribe guardrail blocks a copy that wins by annoying people; skewed assignment blocks everything', () => {
  const blocked = judge([arm('A', true, 1000, 100, 5), arm('B', false, 1000, 160, 40)], { minSample: 100 });
  assert.equal(blocked.status, 'GUARDRAIL_BLOCKED');
  assert.equal(judge([arm('A', true, 1000, 100, 5), arm('B', false, 1000, 160, 6)], { minSample: 100 }).status, 'WINNER');
  assert.equal(judge([arm('A', true, 800, 50), arm('B', false, 200, 40)], { minSample: 100 }).status, 'SAMPLE_RATIO_MISMATCH');
});
test('false-positive rate under the null stays near alpha (simulation, fixed seed)', () => {
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const draw = (n, p) => { let c = 0; for (let i = 0; i < n; i++) if (rnd() < p) c++; return c; };
  let wins = 0; const runs = 400;
  for (let i = 0; i < runs; i++) if (judge([arm('A', true, 1000, draw(1000, 0.1)), arm('B', false, 1000, draw(1000, 0.1))], { minSample: 100, minLift: 0 }).status === 'WINNER') wins++;
  assert.ok(wins / runs < 0.09, `false winners ${wins}/${runs}`);
});
