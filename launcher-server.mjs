// The short-lived launcher detaches the server with file-backed output handles.
// Closing the panel/launcher must not close pipes underneath the running server.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
const output = fs.openSync(path.join(root, 'data', 'startup.log'), 'a');
const errors = fs.openSync(path.join(root, 'data', 'startup-error.log'), 'a');
try {
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, detached: true, windowsHide: true, stdio: ['ignore', output, errors],
  });
  child.once('error', () => { process.exitCode = 1; });
  child.once('spawn', () => child.unref());
} finally {
  fs.closeSync(output);
  fs.closeSync(errors);
}
