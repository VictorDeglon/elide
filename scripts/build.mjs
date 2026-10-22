// Packages extension/ as dist/elide-<version>.zip with a top-level elide-<version>/ folder,
// ready for chrome://extensions → Load unpacked, plus a SHA-256 checksum file.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
const name = `elide-${version}`;
const dist = path.join(root, 'dist');
const stage = path.join(dist, name);
const zip = path.join(dist, `${name}.zip`);

fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(zip, { force: true });
fs.mkdirSync(dist, { recursive: true });
fs.cpSync(path.join(root, 'extension'), stage, { recursive: true, filter: (src) => !src.endsWith('.DS_Store') && !src.includes('_metadata') });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));

execFileSync('zip', ['-r', '-X', '-q', zip, name], { cwd: dist });
fs.rmSync(stage, { recursive: true, force: true });

const sha = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
fs.writeFileSync(`${zip}.sha256`, `${sha}  ${name}.zip\n`);
console.log(`${path.relative(root, zip)}  ${(fs.statSync(zip).size / 1024).toFixed(0)} KB\nsha256 ${sha}`);
