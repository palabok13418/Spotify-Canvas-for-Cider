import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { execSync } from 'node:child_process';

execSync('npm run build', { stdio: 'inherit' });

const dist = path.resolve('dist');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const out = path.resolve(`canvas-for-cider-${pkg.version}.zip`);

if (!fs.existsSync(dist)) {
  throw new Error('Build did not create dist/.');
}

const zip = new JSZip();

function addDir(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const zipPath = path.join(rel, entry.name).replaceAll('\\\\', '/');
    if (entry.isDirectory()) addDir(fullPath, zipPath);
    else zip.file(zipPath, fs.readFileSync(fullPath));
  }
}

addDir(dist);
const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
fs.writeFileSync(out, buffer);
console.log(`Build complete: ${dist}`);
console.log(`Package created: ${out}`);
