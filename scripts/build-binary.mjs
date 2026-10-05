/**
 * Builds a single-file `gpupool` executable, so a GPU machine needs no Node
 * install — download one file and run it.
 *
 * Three steps: bundle to one CommonJS file, wrap it in a Node SEA blob, then
 * inject that blob into a copy of the node binary.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';

const OUT = 'build';
const isWin = platform() === 'win32';
const exeName = isWin ? 'gpupool.exe' : 'gpupool';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. bundle ---------------------------------------------------------------
console.log('bundling...');
await build({
  entryPoints: ['src/agent/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  // SEA runs the blob as CommonJS, so ESM output would fail at startup.
  format: 'cjs',
  outfile: join(OUT, 'agent.cjs'),
  minify: true,
  // Tells service.ts to register the service against this executable rather
  // than against `node <script>`.
  define: { __GPUPOOL_SEA__: 'true' },
  logLevel: 'warning',
});
console.log(`  bundle: ${(statSync(join(OUT, 'agent.cjs')).size / 1024).toFixed(0)} KB`);

// 2. sea blob -------------------------------------------------------------
console.log('building SEA blob...');
const seaConfig = join(OUT, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: join(OUT, 'agent.cjs'),
    output: join(OUT, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    // The agent reads only its own config files, so no assets to embed.
    useSnapshot: false,
    useCodeCache: true,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. inject into a copy of node ------------------------------------------
console.log('injecting into node binary...');
const outExe = join(OUT, exeName);
copyFileSync(process.execPath, outExe);

if (isWin) {
  // An Authenticode signature covers the whole file, so appending a section
  // invalidates it. Removing it first avoids shipping a binary Windows
  // reports as tampered with.
  try {
    execFileSync('signtool', ['remove', '/s', outExe], { stdio: 'ignore' });
    console.log('  stripped existing signature');
  } catch {
    console.log('  signtool unavailable; continuing unsigned');
  }
}

const postjectArgs = [
  outExe,
  'NODE_SEA_BLOB',
  join(OUT, 'sea-prep.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (platform() === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');

// Invoke postject's CLI through node directly: spawning npx.cmd on Windows
// needs a shell, and going through one would mangle these arguments.
const postjectCli = join('node_modules', 'postject', 'dist', 'cli.js');
if (!existsSync(postjectCli)) {
  throw new Error('postject not installed; run npm install --save-dev postject');
}
execFileSync(process.execPath, [postjectCli, ...postjectArgs], { stdio: 'inherit' });

if (platform() === 'darwin') {
  try {
    execFileSync('codesign', ['--sign', '-', outExe], { stdio: 'ignore' });
    console.log('  ad-hoc signed');
  } catch {
    console.log('  codesign failed; binary may be blocked by Gatekeeper');
  }
}

if (!existsSync(outExe)) throw new Error('binary was not produced');
const mb = (statSync(outExe).size / 1024 / 1024).toFixed(1);
console.log(`\n${outExe}  (${mb} MB)`);
console.log('no Node install needed on the target machine.');
