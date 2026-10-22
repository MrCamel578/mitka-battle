'use strict';

const assert = require('node:assert/strict');
const { CASES } = require('../catalog.json');
const {
  POLICY,
  getCaseDistribution,
  pickCaseItem
} = require('../lib/case-balance');

const EPSILON = 1e-9;

function almostEqual(actual, expected, epsilon = EPSILON, message = '') {
  assert.ok(Math.abs(actual - expected) <= epsilon,
    `${message} expected ${expected}, received ${actual}`);
}

function legacyProbabilities(caseDefinition) {
  const counts = Object.create(null);
  for (const item of caseDefinition.pool) counts[item.r] = (counts[item.r] || 0) + 1;
  const raw = caseDefinition.pool.map(item =>
    (POLICY.LEGACY_RARITY_WEIGHTS[item.r] || 1) / counts[item.r]);
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  return raw.map(weight => weight / total);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function seededRandom() {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function withSeed(seed, callback) {
  const originalRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    return callback();
  } finally {
    Math.random = originalRandom;
  }
}

function simulateTenOpeningBatches(caseDefinition, batchCount, seed) {
  const openingCount = 10;
  const poolSet = new Set(caseDefinition.pool);
  const metrics = withSeed(seed, () => {
    let totalPayout = 0;
    let profitableBatches = 0;
    let losingBatches = 0;

    for (let batch = 0; batch < batchCount; batch += 1) {
      let batchPayout = 0;
      for (let opening = 0; opening < openingCount; opening += 1) {
        const item = pickCaseItem(caseDefinition);
        assert.ok(poolSet.has(item), `${caseDefinition.name}: picker emitted an out-of-pool item`);
        batchPayout += item.p;
      }
      totalPayout += batchPayout;
      if (batchPayout > caseDefinition.price * openingCount) profitableBatches += 1;
      if (batchPayout < caseDefinition.price * openingCount) losingBatches += 1;
    }

    const totalCost = caseDefinition.price * openingCount * batchCount;
    return {
      totalCost,
      totalPayout,
      net: totalPayout - totalCost,
      returnRate: totalPayout / totalCost,
      profitableBatches,
      losingBatches
    };
  });
  return metrics;
}

assert.equal(CASES.length, 38, 'catalog fixture must have 38 cases');
assert.equal(Math.min(...CASES.map(c => c.price)), 19);
assert.equal(Math.max(...CASES.map(c => c.price)), 4999);

for (const caseDefinition of CASES) {
  const originalCaseJson = JSON.stringify(caseDefinition);
  const distribution = getCaseDistribution(caseDefinition);

  // Object-keyed caching should return exactly the same immutable result.
  assert.strictEqual(distribution, getCaseDistribution(caseDefinition),
    `${caseDefinition.name}: distribution was not cached by case object`);
  assert.equal(distribution.items.length, caseDefinition.pool.length);
  assert.equal(distribution.weights.length, caseDefinition.pool.length);
  assert.equal(distribution.probabilities.length, caseDefinition.pool.length);
  assert.ok(Object.isFrozen(distribution));
  assert.ok(Object.isFrozen(distribution.items));
  assert.ok(Object.isFrozen(distribution.weights));

  const poolSet = new Set(caseDefinition.pool);
  for (const item of distribution.items) {
    assert.ok(poolSet.has(item), `${caseDefinition.name}: distribution changed the pool`);
  }

  const probabilitySum = distribution.probabilities.reduce((sum, probability) => sum + probability, 0);
  almostEqual(probabilitySum, 1, 1e-12, `${caseDefinition.name}: probability sum`);
  almostEqual(distribution.cumulativeWeights.at(-1), 1, 0,
    `${caseDefinition.name}: final cumulative weight`);

  const recomputedExpectedValue = distribution.items.reduce(
    (sum, item, index) => sum + item.p * distribution.probabilities[index], 0);
  almostEqual(recomputedExpectedValue, distribution.expectedValue, 1e-8,
    `${caseDefinition.name}: expected payout`);
  almostEqual(distribution.expectedValue / caseDefinition.price, distribution.returnRate, 1e-12,
    `${caseDefinition.name}: return rate`);
  assert.equal(JSON.stringify(caseDefinition), originalCaseJson,
    `${caseDefinition.name}: building distribution mutated the catalog`);

  if (caseDefinition.price <= POLICY.CHEAP_MAX_PRICE) {
    const legacy = legacyProbabilities(caseDefinition);
    assert.equal(distribution.lambda, 0, `${caseDefinition.name}: cheap case was tilted`);
    distribution.probabilities.forEach((probability, index) => almostEqual(
      probability, legacy[index], 1e-15,
      `${caseDefinition.name}: cheap legacy probability at ${index}`));
  }

  if (caseDefinition.price >= POLICY.FULL_HOUSE_EDGE_PRICE) {
    almostEqual(distribution.returnRate, POLICY.HIGH_CASE_RTP, 1e-10,
      `${caseDefinition.name}: high-case RTP target`);
    assert.ok(distribution.returnRate >= 0.93 && distribution.returnRate <= 0.96,
      `${caseDefinition.name}: high-case RTP outside house-edge policy`);
    // Gold/yellow is reduced but remains a real drop, not a zero-probability token.
    assert.ok(distribution.tierProbabilities.g >= 0.007,
      `${caseDefinition.name}: gold rarity was made implausibly rare`);
    assert.ok(distribution.tierProbabilities.y >= 0.002,
      `${caseDefinition.name}: yellow rarity was made implausibly rare`);
  }

  if (caseDefinition.price >= POLICY.TRANSITION_START_PRICE &&
      caseDefinition.price < POLICY.FULL_HOUSE_EDGE_PRICE) {
    assert.ok(distribution.returnRate >= POLICY.HIGH_CASE_RTP - EPSILON);
    assert.ok(distribution.returnRate <= POLICY.TRANSITION_START_RTP + EPSILON);
  }
}

const highCases = CASES.filter(c => c.price >= POLICY.FULL_HOUSE_EDGE_PRICE);
assert.equal(highCases.length, 10, 'fixture must cover ten high-price cases');

// 100,000 deterministic batches of ten independent openings for every high
// case: 10,000,000 actual picks.  The expected 5% edge produces a clear total
// loss while rare high-priced items still create some profitable batches.
const simulationRows = [];
for (const caseDefinition of highCases) {
  const simulation = simulateTenOpeningBatches(caseDefinition, 100000,
    0xC0FFEE + caseDefinition.id * 7919);
  assert.ok(simulation.net < 0,
    `${caseDefinition.name}: deterministic high-case simulation did not lose money`);
  assert.ok(simulation.returnRate < 0.99,
    `${caseDefinition.name}: simulated loss was not meaningful`);
  assert.ok(simulation.profitableBatches > 0,
    `${caseDefinition.name}: high-priced drops never produced a profitable batch`);
  assert.ok(simulation.losingBatches > simulation.profitableBatches,
    `${caseDefinition.name}: losses were not more frequent than profits`);
  simulationRows.push({
    id: caseDefinition.id,
    name: caseDefinition.name,
    price: caseDefinition.price,
    returnRate: simulation.returnRate,
    net: simulation.net,
    profitableBatches: simulation.profitableBatches,
    losingBatches: simulation.losingBatches
  });
}

console.log('Case balance checks passed: 38 calibrated/cached distributions; cheap cases retain legacy weights.');
console.log('High-case deterministic simulation (100,000 batches × 10 openings):');
for (const row of simulationRows) {
  console.log(
    `#${row.id} ${row.name} (${row.price} ₽): ` +
    `RTP ${(row.returnRate * 100).toFixed(3)}%, ` +
    `net ${row.net.toFixed(2)} ₽, ` +
    `profit/loss batches ${row.profitableBatches}/${row.losingBatches}`);
}
