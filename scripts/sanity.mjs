import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
for (const [name, spec] of Object.entries(deps)) {
  if (/^(git\+|git:|github:|https?:\/\/|ssh:)/i.test(String(spec))) {
    throw new Error(`Remote/Git package dependency is not allowed: ${name}=${spec}`);
  }
}
if (deps.pnpm) throw new Error('pnpm must not be a project dependency.');
if (deps.esbuild !== '0.28.2') throw new Error(`Expected esbuild 0.28.2, got ${deps.esbuild}`);
if (!deps.jszip) throw new Error('jszip must be declared for scripts/pack.mjs');
if (!deps.vite) throw new Error('Vite is not declared');
if (!String(pkg.scripts?.dev || '').includes('3058')) throw new Error('Dev script must use port 3058');
console.log('Sanity check passed: npm registry dependencies only; esbuild 0.28.2; no pnpm dependency; Vite on port 3058.');
