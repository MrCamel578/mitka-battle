'use strict';

/**
 * Fixed, independently sampled, public case probabilities shared by every user.
 * The rarity baseline follows the well-known CS2 weapon-case tier distribution;
 * custom-case low grades share the common/Mil-Spec tier. For unusually generous
 * custom pools, a public, deterministic item-price tilt caps expected payout at
 * 70% of case price. It only reduces probabilities: low-return cases are never
 * boosted. There is no account state, user ID, streak, batch-size modifier,
 * pity timer, or per-player odds adjustment in this module.
 */

const GROUPS = Object.freeze([
  Object.freeze({ id: 'milSpec', label: 'Базовый пул', rarityCodes: Object.freeze(['c', 'b', 'p']), weight: 0.7992, color: '#4b69ff' }),
  Object.freeze({ id: 'restricted', label: 'Restricted', rarityCodes: Object.freeze(['k']), weight: 0.1598, color: '#8847ff' }),
  Object.freeze({ id: 'classified', label: 'Classified', rarityCodes: Object.freeze(['d']), weight: 0.032, color: '#d32ce6' }),
  Object.freeze({ id: 'covert', label: 'Covert', rarityCodes: Object.freeze(['g']), weight: 0.0064, color: '#eb4b4b' }),
  Object.freeze({ id: 'special', label: 'Exceedingly Rare', rarityCodes: Object.freeze(['y', 'u']), weight: 0.0026, color: '#e4ae39' })
]);
const RARITY_GROUP = Object.freeze(Object.fromEntries(
  GROUPS.flatMap(group => group.rarityCodes.map(code => [code, group.id]))
));
const POLICY = Object.freeze({
  name: 'CS2_STYLE_PUBLIC_FIXED_ODDS',
  source: 'CS2 weapon-case tier weights with a conservative cap for custom pools',
  targetReturnRateCap: 0.70,
  independentDraws: true,
  sameForEveryPlayer: true,
  perUserAdjustments: false,
  basePercentages: Object.freeze({ milSpec: 79.92, restricted: 15.98, classified: 3.2, covert: 0.64, special: 0.26 }),
  groups: GROUPS
});
const distributionCache = new WeakMap();

function assertCase(caseDefinition) {
  if (!caseDefinition || typeof caseDefinition !== 'object') throw new TypeError('Case definition must be an object');
  if (!Number.isFinite(caseDefinition.price) || caseDefinition.price <= 0) throw new RangeError('Case price must be a positive finite number');
  if (!Array.isArray(caseDefinition.pool) || caseDefinition.pool.length === 0) throw new RangeError('Case pool must be a non-empty array');
  for (const item of caseDefinition.pool) {
    if (!item || typeof item !== 'object' || typeof item.r !== 'string' || !Object.hasOwn(RARITY_GROUP, item.r) ||
        !Number.isFinite(item.p) || item.p < 0) {
      throw new TypeError('Every case item must have a supported rarity and non-negative finite payout');
    }
  }
}

function mean(items, probabilities) {
  return items.reduce((sum, item, index) => sum + item.p * probabilities[index], 0);
}
function normalize(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) throw new RangeError('Case distribution has no positive total weight');
  return values.map(value => value / total);
}
function stableExponentialTilt(items, baseProbabilities, price, lambda) {
  const logs = items.map((item, index) => Math.log(baseProbabilities[index]) - lambda * item.p / price);
  const max = Math.max(...logs);
  // Retain a tiny positive chance for every catalogue item rather than creating
  // accidental zero-probability tokens through floating-point underflow.
  return normalize(logs.map(logWeight => Math.exp(Math.max(-700, logWeight - max))));
}
function capExpectedPayout(items, baseProbabilities, price) {
  const baseValue = mean(items, baseProbabilities);
  const capValue = price * POLICY.targetReturnRateCap;
  if (baseValue <= capValue) return { probabilities: baseProbabilities, baseValue, capped: false, targetValue: baseValue };

  const minimumValue = Math.min(...items.map(item => item.p));
  const targetValue = Math.max(capValue, minimumValue);
  let low = 0;
  let high = 1;
  while (mean(items, stableExponentialTilt(items, baseProbabilities, price, high)) > targetValue && high < 1e9) high *= 2;
  for (let iteration = 0; iteration < 90; iteration += 1) {
    const middle = (low + high) / 2;
    const value = mean(items, stableExponentialTilt(items, baseProbabilities, price, middle));
    if (value > targetValue) low = middle;
    else high = middle;
  }
  return {
    probabilities: stableExponentialTilt(items, baseProbabilities, price, high),
    baseValue,
    capped: true,
    targetValue
  };
}
function sumByGroup(items, probabilities) {
  const result = Object.create(null);
  for (const group of GROUPS) result[group.id] = 0;
  items.forEach((item, index) => { result[RARITY_GROUP[item.r]] += probabilities[index]; });
  return result;
}
function sumByRarity(items, probabilities) {
  const result = Object.create(null);
  items.forEach((item, index) => { result[item.r] = (result[item.r] || 0) + probabilities[index]; });
  return result;
}
function buildDistribution(caseDefinition) {
  assertCase(caseDefinition);
  const counts = Object.create(null);
  const groupCounts = Object.create(null);
  for (const item of caseDefinition.pool) {
    counts[item.r] = (counts[item.r] || 0) + 1;
    const group = RARITY_GROUP[item.r];
    groupCounts[group] = (groupCounts[group] || 0) + 1;
  }

  const availableGroups = GROUPS.filter(group => groupCounts[group.id] > 0);
  const totalAvailableWeight = availableGroups.reduce((sum, group) => sum + group.weight, 0);
  if (totalAvailableWeight <= 0) throw new RangeError('Case has no supported outcome group');
  const baselineGroupProbabilities = Object.create(null);
  for (const group of GROUPS) {
    baselineGroupProbabilities[group.id] = groupCounts[group.id] ? group.weight / totalAvailableWeight : 0;
  }
  const baselineProbabilities = normalize(caseDefinition.pool.map(item =>
    baselineGroupProbabilities[RARITY_GROUP[item.r]] / groupCounts[RARITY_GROUP[item.r]]
  ));
  const capped = capExpectedPayout(caseDefinition.pool, baselineProbabilities, caseDefinition.price);
  const probabilities = capped.probabilities;
  const cumulativeWeights = [];
  let cumulative = 0;
  probabilities.forEach(probability => { cumulative += probability; cumulativeWeights.push(cumulative); });
  cumulativeWeights[cumulativeWeights.length - 1] = 1;
  const expectedValue = mean(caseDefinition.pool, probabilities);

  return Object.freeze({
    items: Object.freeze(caseDefinition.pool.slice()),
    weights: Object.freeze(probabilities.slice()),
    probabilities: Object.freeze(probabilities.slice()),
    baselineProbabilities: Object.freeze(baselineProbabilities.slice()),
    cumulativeWeights: Object.freeze(cumulativeWeights),
    tierProbabilities: Object.freeze(sumByRarity(caseDefinition.pool, probabilities)),
    baselineGroupProbabilities: Object.freeze({ ...baselineGroupProbabilities }),
    groupProbabilities: Object.freeze(sumByGroup(caseDefinition.pool, probabilities)),
    rarityCounts: Object.freeze({ ...counts }),
    groupCounts: Object.freeze({ ...groupCounts }),
    expectedValue,
    baseExpectedValue: capped.baseValue,
    returnRate: expectedValue / caseDefinition.price,
    baselineReturnRate: capped.baseValue / caseDefinition.price,
    targetReturnRate: capped.targetValue / caseDefinition.price,
    calibratedForCap: capped.capped
  });
}
function getCaseDistribution(caseDefinition) {
  let distribution = distributionCache.get(caseDefinition);
  if (!distribution) {
    distribution = buildDistribution(caseDefinition);
    distributionCache.set(caseDefinition, distribution);
  }
  return distribution;
}
function pickCaseItem(caseDefinition) {
  const distribution = getCaseDistribution(caseDefinition);
  const roll = Math.random();
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new RangeError('Math.random() must return a finite number in [0, 1)');
  for (let index = 0; index < distribution.cumulativeWeights.length; index += 1) {
    if (roll < distribution.cumulativeWeights[index]) return distribution.items[index];
  }
  return distribution.items[distribution.items.length - 1];
}

module.exports = Object.freeze({ POLICY, GROUPS, RARITY_GROUP, getCaseDistribution, pickCaseItem });
