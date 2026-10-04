import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runtimeFiles, safeDistributionPath } from './distribution.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
const label = `RealManager-${version}-win-x64`;
const workBase = path.resolve(root, '../../work/packaging');
await fs.mkdir(workBase, { recursive: true });
const workspace = await fs.mkdtemp(path.join(workBase, 'build-'));
const stage = path.join(workspace, label);
await fs.mkdir(stage);

async function run(exe, args, cwd = workspace) {
  await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Build command failed (${code}).`)));
  });
}
for (const file of runtimeFiles) {
  if (!safeDistributionPath(file)) throw new Error(`Unsafe distribution entry: ${file}`);
  const target = path.join(stage, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(root, file), target);
}
await fs.copyFile(path.join(root, 'Real Manager.exe'), path.join(stage, 'Real Manager.exe'));

// Get an official, pinned Node.js runtime with its complete third-party LICENSE.
const nodeVersion = 'v24.19.0';
const nodeArchive = `node-${nodeVersion}-win-x64.zip`;
const nodeBase = `https://nodejs.org/dist/${nodeVersion}/`;
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await download(nodeBase + 'SHASUMS256.txt')).toString('utf8');
const expected = sums.split(/\r?\n/).find(line => line.endsWith('  ' + nodeArchive))?.split(/\s+/)[0];
if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Missing official runtime SHA-256.');
const cached = path.join(workBase, nodeArchive);
let nodeZip;
try { nodeZip = await fs.readFile(cached); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!nodeZip || crypto.createHash('sha256').update(nodeZip).digest('hex') !== expected) {
  nodeZip = await download(nodeBase + nodeArchive);
  if (crypto.createHash('sha256').update(nodeZip).digest('hex') !== expected) throw new Error('Node.js checksum mismatch.');
  await fs.writeFile(cached, nodeZip);
}
const unpacked = path.join(workspace, 'node');
process.env.REAL_BUILD_ARCHIVE = cached;
process.env.REAL_BUILD_UNPACK = unpacked;
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Expand-Archive -LiteralPath $env:REAL_BUILD_ARCHIVE -DestinationPath $env:REAL_BUILD_UNPACK']);
const runtime = path.join(stage, 'runtime');
await fs.mkdir(runtime);
const extracted = path.join(unpacked, `node-${nodeVersion}-win-x64`);
for (const file of ['node.exe', 'LICENSE']) await fs.copyFile(path.join(extracted, file), path.join(runtime, file));
await fs.writeFile(path.join(runtime, 'VERSION.txt'), `${nodeVersion}\n${nodeBase}\nArchive SHA-256: ${expected}\n`);

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
await fs.access(npmCli);
await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);
// ZIP streaming avoids holding all dependencies and compressed output in memory.
const releaseDirectory = path.join(root, 'releases');
await fs.mkdir(releaseDirectory, { recursive: true });
const output = path.join(releaseDirectory, label + '.zip');
try { await fs.access(output); throw new Error('Release ZIP already exists. Move it aside before rebuilding.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
process.env.REAL_BUILD_STAGE = stage;
process.env.REAL_BUILD_OUTPUT = output;
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  'Compress-Archive -LiteralPath $env:REAL_BUILD_STAGE -DestinationPath $env:REAL_BUILD_OUTPUT -CompressionLevel Optimal']);
const digest = crypto.createHash('sha256').update(await fs.readFile(output)).digest('hex');
await fs.writeFile(output + '.sha256', `${digest}  ${path.basename(output)}\n`);
console.log(`Portable: ${output}\nSHA-256: ${digest}\nClean staging folder: ${stage}`);
