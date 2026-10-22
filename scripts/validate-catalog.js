'use strict';
const assert = require('node:assert/strict');
const { SK, CASES } = require('../catalog.json');
const { getCaseDistribution } = require('../lib/case-balance');
if (SK.length < 100) throw new Error(`Expected expanded skin catalog, got ${SK.length}`);
if (!CASES.length) throw new Error('Case catalog is empty');
for (const c of CASES) {
  const d = getCaseDistribution(c);
  const sum = d.probabilities.reduce((total, probability) => total + probability, 0);
  if (Math.abs(sum - 1) > 1e-10) throw new Error(`Probabilities do not sum to 100% for ${c.name}`);
  if (d.probabilities.some(p => !Number.isFinite(p) || p <= 0)) throw new Error(`Invalid probability for ${c.name}`);
}
const names = SK.map(s => s[0]);
if (new Set(names).size !== names.length) throw new Error('Duplicate skin names in catalog');
assert.deepEqual(require('../public/catalog.json'), { SK, CASES }, 'Server and frontend catalogs differ');
console.log(`Catalog OK: ${SK.length} skins, ${CASES.length} cases, ${CASES.reduce((n, c) => n + c.pool.length, 0)} case drops. Actual server probabilities sum to 100%.`);
