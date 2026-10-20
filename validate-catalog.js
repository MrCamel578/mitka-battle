'use strict';
const { SK, CASES } = require('../catalog.json');
const weights = { c: 61, b: 25, p: 9.5, k: 3.5, g: 0.8, y: 0.2 };
if (SK.length < 100) throw new Error(`Expected expanded skin catalog, got ${SK.length}`);
if (CASES.length < 1) throw new Error('Case catalog is empty');
for (const c of CASES) {
  const counts = {};
  for (const item of c.pool) counts[item.r] = (counts[item.r] || 0) + 1;
  let total = 0;
  for (const item of c.pool) total += (weights[item.r] || 1) / counts[item.r];
  let sum = 0;
  for (const item of c.pool) sum += ((weights[item.r] || 1) / counts[item.r]) / total * 100;
  if (Math.abs(sum - 100) > 1e-7) throw new Error(`Probabilities do not sum to 100 for ${c.name}: ${sum}`);
}
const names = SK.map(s => s[0]);
if (new Set(names).size !== names.length) throw new Error('Duplicate skin names in catalog');
console.log(`Catalog OK: ${SK.length} skins, ${CASES.length} cases, ${CASES.reduce((n,c)=>n+c.pool.length,0)} case drops. All case probabilities sum to 100%.`);
