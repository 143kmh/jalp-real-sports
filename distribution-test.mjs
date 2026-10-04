import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runtimeFiles, sourceFiles, safeDistributionPath } from './distribution.mjs';

test('publication and portable allowlists exclude all personal artifacts', async () => {
  assert.equal(new Set(sourceFiles).size, sourceFiles.length);
  for (const file of sourceFiles) {
    assert.ok(safeDistributionPath(file), file);
    await fs.access(new URL(file, import.meta.url));
  }
  for (const file of ['data/accounts.dpapi', 'data/settings.json', '../file', '/file', 'file\\path', 'proof.png', 'account.har', '.git/config'])
    assert.equal(safeDistributionPath(file), false, file);
  assert.ok(runtimeFiles.includes('launcher-server.mjs'));
  assert.ok(runtimeFiles.includes('helium-extension/real.js'));
  assert.ok(!runtimeFiles.some(name => name.endsWith('-test.mjs')));
});
test('launcher separates panel and Real profiles and never starts a second server if ready', async () => {
  const source = await fs.readFile(new URL('Launcher.cs', import.meta.url), 'utf8');
  assert.match(source, /if \(Ready\(\)\) return/);
  assert.match(source, /panel-profile/);
  assert.match(source, /--app=/);
  assert.match(source, /CreateNoWindow = true/);
  assert.match(source, /RootHash\(\)/);
  assert.match(source, /--no-ui/);
  assert.doesNotMatch(source, /Kill\(|taskkill|--remote-debugging/);
});
