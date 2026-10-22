'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let checked = 0;
function check(source, label) {
  const result = spawnSync(process.execPath, ['--check'], { input: source, encoding: 'utf8' });
  if (result.status !== 0) { console.error(`Ошибка синтаксиса: ${label}\n${result.stderr}`); process.exit(1); }
  checked++;
}
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filename);
    else if (entry.name.endsWith('.js')) check(fs.readFileSync(filename, 'utf8'), path.relative(root, filename));
  }
}
walk(root);
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
let inline = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc\s*=/.test(match[1]) && match[2].trim()) check(match[2], `public/index.html inline ${++inline}`);
}
console.log(`Синтаксис проверен: ${checked} файлов/блоков JavaScript.`);
