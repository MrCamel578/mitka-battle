'use strict';

/**
 * Stateless case-drop distribution builder.
 *
 * Item pools and item prices are never changed.  For cases above the cheap
 * tier we only reweight the existing entries, then pick independently on every
 * call.  The WeakMap intentionally keys by the case object: calling code can
 * use the catalog objects directly without recomputing their calibration.
 */

const LEGACY_RARITY_WEIGHTS = Object.freeze({
  c: 50,
  b: 27,
  p: 13,
  k: 6,
  g: 3,
  y: 1
});

const POLICY = Object.freeze({
  // Cases at or below this price retain the legacy rarity distribution exactly.
  CHEAP_MAX_PRICE: 749,
  TRANSITION_START_PRICE: 899,
  FULL_HOUSE_EDGE_PRICE: 1499,

  // 899 ₽ cases remain comparatively soft, but no longer retain 1.5–2.1 RTP.
  // The target then decreases linearly to the 5% house edge at 1499 ₽.
  TRANSITION_START_RTP: 1.15,
  HIGH_CASE_RTP: 0.95,

  LEGACY_RARITY_WEIGHTS,
  BINARY_SEARCH_ITERATIONS: 80,
  MINIMUM_PAYOUT_FOR_LOG: 0.01
});

const distributionCache = new WeakMap();

function assertCase(caseDefinition) {
  if (!caseDefinition || typeof caseDefinition !== 'object') {
    throw new TypeError('Case definition must be an object');
  }
  if (!Number.isFinite(caseDefinition.price) || caseDefinition.price <= 0) {
    throw new RangeError('Case price must be a positive finite number');
  }
  if (!Array.isArray(caseDefinition.pool) || caseDefinition.pool.length === 0) {
    throw new RangeError('Case pool must be a non-empty array');
  }
  for (const item of caseDefinition.pool) {
    if (!item || typeof item !== 'object' || typeof item.r !== 'string' ||
        !Number.isFinite(item.p) || item.p < 0) {
      throw new TypeError('Every case item must have a rarity and non-negative finite payout');
    }
  }
}

function getTargetReturnRate(price) {
  if (price <= POLICY.CHEAP_MAX_PRICE) return null;
  if (price >= POLICY.FULL_HOUSE_EDGE_PRICE) return POLICY.HIGH_CASE_RTP;

  // There are no catalog cases from 750 through 898.  At 899 ₽ this begins the
  // deliberate softening; by 1499 ₽ the full 5% house edge applies.
  const progress = Math.max(0, Math.min(1,
    (price - POLICY.TRANSITION_START_PRICE) /
    (POLICY.FULL_HOUSE_EDGE_PRICE - POLICY.TRANSITION_START_PRICE)));
  return POLICY.TRANSITION_START_RTP +
    (POLICY.HIGH_CASE_RTP - POLICY.TRANSITION_START_RTP) * progress;
}

function makeBaseWeights(caseDefinition) {
  const counts = Object.create(null);
  for (const item of caseDefinition.pool) {
    counts[item.r] = (counts[item.r] || 0) + 1;
  }
  return {
    counts,
    values: caseDefinition.pool.map(item =>
      (POLICY.LEGACY_RARITY_WEIGHTS[item.r] || 1) / counts[item.r])
  };
}

function normalize(rawWeights) {
  const total = rawWeights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new RangeError('Case distribution has no positive finite total weight');
  }
  return rawWeights.map(weight => weight / total);
}

function expectedValue(items, probabilities) {
  return items.reduce((sum, item, index) => sum + item.p * probabilities[index], 0);
}

function tiltedProbabilities(caseDefinition, baseWeights, lambda) {
  const price = caseDefinition.price;
  const rawWeights = caseDefinition.pool.map((item, index) => {
    const payout = Math.max(item.p, POLICY.MINIMUM_PAYOUT_FOR_LOG);
    const priceRelativeLog = Math.log(payout / price);
    return baseWeights[index] * Math.exp(-lambda * priceRelativeLog);
  });
  return normalize(rawWeights);
}

/**
 * Find lambda such that the exponentially tilted distribution has target EV.
 * E[payout] is monotonic decreasing as lambda grows, so bisection is stable.
 */
function calibrateLambda(caseDefinition, baseWeights, targetExpectedValue) {
  const evaluate = lambda => {
    const probabilities = tiltedProbabilities(caseDefinition, baseWeights, lambda);
    return expectedValue(caseDefinition.pool, probabilities);
  };

  const baseline = evaluate(0);
  const tolerance = Math.max(1e-9, targetExpectedValue * 1e-12);
  if (Math.abs(baseline - targetExpectedValue) <= tolerance) return 0;

  // Keep a bracket [low, high] with E(low) >= target >= E(high).
  let low = 0;
  let high = 0;
  if (baseline > targetExpectedValue) {
    high = 1;
    while (evaluate(high) > targetExpectedValue && high < 1024) high *= 2;
  } else {
    low = -1;
    while (evaluate(low) < targetExpectedValue && low > -1024) low *= 2;
  }

  if (evaluate(low) + tolerance < targetExpectedValue ||
      evaluate(high) - tolerance > targetExpectedValue) {
    throw new RangeError('Target payout is outside the reachable case-pool range');
  }

  for (let iteration = 0; iteration < POLICY.BINARY_SEARCH_ITERATIONS; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (evaluate(midpoint) > targetExpectedValue) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function buildDistribution(caseDefinition) {
  assertCase(caseDefinition);

  const { counts, values: baseWeights } = makeBaseWeights(caseDefinition);
  const targetReturnRate = getTargetReturnRate(caseDefinition.price);
  const baselineProbabilities = normalize(baseWeights);
  const baselineExpectedValue = expectedValue(caseDefinition.pool, baselineProbabilities);
  const targetExpectedValue = targetReturnRate === null
    ? baselineExpectedValue
    : caseDefinition.price * targetReturnRate;
  const lambda = targetReturnRate === null
    ? 0
    : calibrateLambda(caseDefinition, baseWeights, targetExpectedValue);
  const probabilities = targetReturnRate === null
    ? baselineProbabilities
    : tiltedProbabilities(caseDefinition, baseWeights, lambda);
  const calibratedExpectedValue = expectedValue(caseDefinition.pool, probabilities);

  const cumulativeWeights = [];
  let cumulative = 0;
  const tierProbabilities = Object.create(null);
  for (let index = 0; index < caseDefinition.pool.length; index += 1) {
    const item = caseDefinition.pool[index];
    cumulative += probabilities[index];
    cumulativeWeights.push(cumulative);
    tierProbabilities[item.r] = (tierProbabilities[item.r] || 0) + probabilities[index];
  }
  // Absorb harmless floating-point accumulation in the final roulette bucket.
  cumulativeWeights[cumulativeWeights.length - 1] = 1;

  return Object.freeze({
    // These are original pool items, never copied, edited, or synthesized.
    items: Object.freeze(caseDefinition.pool.slice()),
    // `weights` is kept as a concise public alias for normalized probabilities.
    weights: Object.freeze(probabilities.slice()),
    probabilities: Object.freeze(probabilities.slice()),
    cumulativeWeights: Object.freeze(cumulativeWeights),
    tierProbabilities: Object.freeze({ ...tierProbabilities }),
    rarityCounts: Object.freeze({ ...counts }),
    expectedValue: calibratedExpectedValue,
    returnRate: calibratedExpectedValue / caseDefinition.price,
    targetExpectedValue,
    targetReturnRate: targetReturnRate === null
      ? baselineExpectedValue / caseDefinition.price
      : targetReturnRate,
    baselineExpectedValue,
    baselineReturnRate: baselineExpectedValue / caseDefinition.price,
    lambda
  });
}

/**
 * Return the deterministic, cached distribution for one catalog case object.
 */
function getCaseDistribution(caseDefinition) {
  let distribution = distributionCache.get(caseDefinition);
  if (!distribution) {
    distribution = buildDistribution(caseDefinition);
    distributionCache.set(caseDefinition, distribution);
  }
  return distribution;
}

/**
 * Pick one original pool item.  Every call is an independent Math.random draw;
 * there is no player, balance, counter, or opening-count input/state here.
 */
function pickCaseItem(caseDefinition) {
  const distribution = getCaseDistribution(caseDefinition);
  const roll = Math.random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new RangeError('Math.random() must return a finite number in [0, 1)');
  }
  for (let index = 0; index < distribution.cumulativeWeights.length; index += 1) {
    if (roll < distribution.cumulativeWeights[index]) return distribution.items[index];
  }
  // The cumulative final bucket is forced to one, so this is defensive only.
  return distribution.items[distribution.items.length - 1];
}

module.exports = Object.freeze({
  POLICY,
  getCaseDistribution,
  pickCaseItem
});
