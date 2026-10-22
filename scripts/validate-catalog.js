'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SK, CASES } = require('../catalog.json');
const { getCaseDistribution, RARITY_GROUP } = require('../lib/case-balance');
const catalogPath = path.join(__dirname, '..', 'public', 'catalog.json');
assert.ok(SK.length >= 100, `Expected expanded skin catalog, got ${SK.length}`);
assert.equal(CASES.length, 38, 'Unexpected number of cases');
assert.ok(SK.every(skin => skin.length >= 4 && typeof skin[3] === 'string' && /^\/skins\/\d{3}\.png$/.test(skin[3])), 'Every skin needs its local Steam item thumbnail');
const names = SK.map(skin => skin[0]);
assert.equal(new Set(names).size, names.length, 'Duplicate skin names in catalog');
for (const skin of SK) {
  assert.ok(Object.hasOwn(RARITY_GROUP, skin[2]), `${skin[0]}: unsupported CS2 rarity code ${skin[2]}`);
  const image = path.join(__dirname, '..', 'public', skin[3].replace(/^\//, ''));
  const bytes = fs.readFileSync(image);
  assert.ok(bytes.length > 5000, `${skin[0]}: missing or unexpectedly small item image`);
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${skin[0]}: invalid PNG signature`);
}
const namesSet = new Set(names);
let dropCount = 0;
for (const caseDefinition of CASES) {
  const distribution = getCaseDistribution(caseDefinition);
  assert.ok(Math.abs(distribution.probabilities.reduce((sum, value) => sum + value, 0) - 1) < 1e-10, `${caseDefinition.name}: chances do not sum to 100%`);
  assert.ok(distribution.probabilities.every(value => Number.isFinite(value) && value > 0), `${caseDefinition.name}: invalid drop probability`);
  for (const item of caseDefinition.pool) {
    assert.ok(namesSet.has(item.n), `${caseDefinition.name}: missing skin image mapping for ${item.n}`);
    assert.ok(Object.hasOwn(RARITY_GROUP, item.r), `${caseDefinition.name}: unsupported item rarity ${item.r}`);
  }
  dropCount += caseDefinition.pool.length;
}
assert.deepEqual(require(catalogPath), { SK, CASES }, 'Server and frontend catalogs differ');
console.log(`Catalog OK: ${SK.length} skins, ${CASES.length} cases, ${dropCount} case drops; local CS2 item previews and server probabilities validated.`);
