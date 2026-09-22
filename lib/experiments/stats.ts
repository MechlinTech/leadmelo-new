// Pure statistics for A/B tests on proportions. No database access.

// Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation (abs error < 1.5e-7).
export function normalCdf(z: number) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// Two-sided pooled two-proportion z-test. Returns p = 1 when the test is undefined.
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number) {
  if (n1 <= 0 || n2 <= 0) return { z: 0, p: 1, diff: 0 };
  const p1 = x1 / n1, p2 = x2 / n2, pooled = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, p: 1, diff: p2 - p1 };
  const z = (p2 - p1) / se;
  return { z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))), diff: p2 - p1 };
}

// Chi-square survival function for small integer degrees of freedom (df >= 1) via series.
export function chiSquareSurvival(x: number, df: number) {
  if (x <= 0) return 1;
  if (df === 2) return Math.exp(-x / 2);
  if (df === 1) return 2 * (1 - normalCdf(Math.sqrt(x)));
  // Regularised upper incomplete gamma Q(df/2, x/2) by series/continued fraction.
  const a = df / 2, xx = x / 2, lg = lgamma(a);
  if (xx < a + 1) {
    let sum = 1 / a, term = sum;
    for (let n = 1; n < 500; n++) { term *= xx / (a + n); sum += term; if (Math.abs(term) < 1e-12) break; }
    return Math.max(0, 1 - sum * Math.exp(-xx + a * Math.log(xx) - lg));
  }
  let b = xx + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break;
  }
  return Math.min(1, Math.exp(-xx + a * Math.log(xx) - lg) * h);
}
function lgamma(x: number) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015; for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

// Sample-ratio-mismatch check: observed arm sizes vs the configured weights. A tiny p means the
// assignment mechanism is broken and results must not be trusted.
export function sampleRatioMismatch(counts: number[], weights: number[]) {
  const total = counts.reduce((a, b) => a + b, 0), wsum = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || counts.length < 2) return { chi2: 0, p: 1 };
  const chi2 = counts.reduce((s, o, i) => { const e = total * weights[i] / wsum; return s + (o - e) ** 2 / e; }, 0);
  return { chi2, p: chiSquareSurvival(chi2, counts.length - 1) };
}

export type ArmStats = { variantId: string; label: string; isControl: boolean; weight: number; sent: number; primary: number; unsubscribed: number };
export type Verdict = { status: 'INSUFFICIENT_DATA' | 'SAMPLE_RATIO_MISMATCH' | 'NO_SIGNIFICANT_DIFFERENCE' | 'GUARDRAIL_BLOCKED' | 'WINNER'; winnerVariantId?: string; detail: Record<string, unknown> };

// Winner rules (all must hold): every arm has at least minSample sends; assignment ratios look
// sound; the best non-control arm beats control on the primary metric with Bonferroni-corrected
// p < alpha and an absolute lift of at least minLift; and it does not raise unsubscribes
// significantly (p < 0.05, one direction).
export function judge(arms: ArmStats[], opts: { minSample: number; alpha?: number; minLift?: number }): Verdict {
  const alpha = opts.alpha ?? 0.05, minLift = opts.minLift ?? 0.01;
  const control = arms.find(a => a.isControl), others = arms.filter(a => !a.isControl);
  if (!control || others.length === 0) return { status: 'INSUFFICIENT_DATA', detail: { reason: 'needs_control_and_variant' } };
  if (arms.some(a => a.sent < opts.minSample)) return { status: 'INSUFFICIENT_DATA', detail: { minSample: opts.minSample, sent: Object.fromEntries(arms.map(a => [a.label, a.sent])) } };
  const srm = sampleRatioMismatch(arms.map(a => a.sent), arms.map(a => a.weight));
  if (srm.p < 0.001) return { status: 'SAMPLE_RATIO_MISMATCH', detail: srm };
  const corrected = alpha / others.length;
  const tests = others.map(a => ({ arm: a, test: twoProportionTest(control.primary, control.sent, a.primary, a.sent) })).sort((x, y) => y.test.diff - x.test.diff);
  const best = tests[0];
  const detail = { control: { label: control.label, rate: control.primary / control.sent }, best: { label: best.arm.label, rate: best.arm.primary / best.arm.sent, lift: best.test.diff, p: best.test.p }, correctedAlpha: corrected };
  if (best.test.diff < minLift || best.test.p >= corrected) return { status: 'NO_SIGNIFICANT_DIFFERENCE', detail };
  const unsub = twoProportionTest(control.unsubscribed, control.sent, best.arm.unsubscribed, best.arm.sent);
  if (unsub.diff > 0 && unsub.p < 0.05) return { status: 'GUARDRAIL_BLOCKED', winnerVariantId: best.arm.variantId, detail: { ...detail, unsubscribeP: unsub.p } };
  return { status: 'WINNER', winnerVariantId: best.arm.variantId, detail };
}
