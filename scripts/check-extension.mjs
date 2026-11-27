// Load check: the manifest parses, every file it references exists, every local
// script/stylesheet/import those files reference exists, and every JS file parses.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const problems = [];
const seen = new Set();

function visit(file, from) {
  const abs = resolve(root, file);
  if (seen.has(abs)) return;
  seen.add(abs);
  if (!existsSync(abs)) return problems.push(`missing ${relative(root, abs)} (referenced by ${from})`);
  const text = readFileSync(abs, 'utf8');
  const refs = abs.endsWith('.html')
    ? [...text.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1])
    : abs.endsWith('.js')
      ? [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'(\.[^']+)'/gm)].map((m) => m[1])
      : [];
  for (const ref of refs) visit(relative(root, resolve(dirname(abs), ref)), relative(root, abs));
  if (abs.endsWith('.js')) {
    try {
      execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    } catch (err) {
      problems.push(`syntax error in ${relative(root, abs)}: ${err.stderr}`);
    }
  }
}

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
for (const file of referenced) visit(file, 'manifest.json');

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`manifest ok: ${seen.size} files checked`);
