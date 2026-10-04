import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHar, publicAccount, verifyAccount, openPack, OperationError, requestToken } from './core.mjs';
import Hashids from 'hashids';
import { Store, protect } from './storage.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

function harEntry(id = 'alpha', name = 'Alice', encoded = false) {
  const content = JSON.stringify({ user: { id, userName: name, virtualCurrencyBalance: 1000 } });
  return { startedDateTime: '2026-10-03T00:00:00Z',
    request: { url: 'https://web.realapp.com/user', method: 'GET', headers: [
      { name: 'real-auth-info', value: `secret-${id}` }, { name: 'real-session-token', value: 'session' },
      { name: 'real-request-token', value: 'nonce' }, { name: 'other-sensitive', value: 'discard' },
    ] },
    response: { status: 200, content: { text: encoded ? Buffer.from(content).toString('base64') : content, encoding: encoded ? 'base64' : undefined } },
  };
}
function account() { return parseHar({ log: { entries: [harEntry()] } })[0]; }
function mock({ userId = 'alpha', balance = 1000, cost = 200, disabled = null, postError = null, malformed = false } = {}) {
  const calls = [];
  const request = async (a, method, url, body) => {
    calls.push({ id: a.id, method, url, body });
    if (url === '/user') return { user: { id: userId, userName: 'Alice', virtualCurrencyBalance: balance } };
    if (method === 'GET') {
      const query=new URL(url,'https://web.realapp.com').searchParams;
      return { info: { sport:query.get('sport'),season:query.get('season'),cost,purchaseDisabledMessage:disabled } };
    }
    if (postError) throw postError;
    if (malformed) return { success: true };
    return { pack: { id:12,userId:'alpha',sport:body.sport,season:body.season,cost, cards:[{ id:1,entityLabel:'Play',rarityLabel:'Rare' }],boosterCards:[{ id:2,entityLabel:'PTD',rarityLabel:'Common' }] } };
  };
  return { calls, request };
}

test('HAR imports all accounts, deduplicates and decodes base64', () => {
  const result = parseHar({ log: { entries: [harEntry(), harEntry('beta','Bob',true), harEntry('alpha','Updated')] } });
  assert.equal(result.length, 2); assert.equal(result[0].name, 'Updated'); assert.equal(result[1].id, 'beta');
  assert.equal(result[0].headers['real-request-token'], undefined);
  assert.equal(result[0].headers['other-sensitive'], undefined);
});
test('public account contains no authentication headers', () => {
  const serialized = JSON.stringify(publicAccount(account()));
  assert.ok(!serialized.includes('secret-')); assert.ok(!serialized.includes('headers'));
});
test('invalid HAR has actionable error', () => {
  assert.throws(() => parseHar({ log: { entries: [] } }), /GET \/user/);
});
test('request-token encodes current milliseconds using the public Real client format', () => {
  const time = 1791066360000;
  assert.deepEqual(new Hashids('realwebapp',16).decode(requestToken(time)),[time]);
  assert.equal(requestToken(time).length,16);
  assert.notEqual(requestToken(time),requestToken(time+1));
});
test('account mismatch prevents purchase and shop lookup', async () => {
  const m = mock({ userId: 'beta' });
  await assert.rejects(openPack(account(),'nfl',200,m.request), /другой аккаунт/);
  assert.equal(m.calls.length, 1);
});
test('changed price prevents purchase', async () => {
  const m = mock({ cost: 300 }); await assert.rejects(openPack(account(),'nfl',200,m.request), /Цена изменилась/);
  assert.ok(m.calls.every(c => c.method === 'GET'));
});
test('insufficient balance prevents purchase', async () => {
  const m = mock({ balance: 100 }); await assert.rejects(openPack(account(),'nfl',200,m.request), /Недостаточно/);
  assert.ok(m.calls.every(c => c.method === 'GET'));
});
test('disabled pack prevents purchase', async () => {
  const m = mock({ disabled: 'Daily limit' }); await assert.rejects(openPack(account(),'nfl',200,m.request), /недоступен/);
  assert.ok(m.calls.every(c => c.method === 'GET'));
});
test('purchase verifies identity, sends exact payload once and includes boosters', async () => {
  const m = mock(), a = account(); const result = await openPack(a,'nfl',200,m.request);
  assert.deepEqual(m.calls.map(c => c.method), ['GET','GET','POST']);
  assert.deepEqual(m.calls[2].body, { sport:'nfl', season:'2026', cost:200, acceptPriceChanges:false });
  assert.equal(result.cards.length, 2); assert.equal(a.balance, 800);
});
test('lost response is not retried', async () => {
  const m = mock({ postError: new OperationError('timeout', true) });
  await assert.rejects(openPack(account(),'nfl',200,m.request), e => e.uncertain === true);
  assert.equal(m.calls.filter(c => c.method === 'POST').length, 1);
});
test('UFC uses the recorded all-time season', async () => {
  const m = mock(); await openPack(account(),'ufc',200,m.request);
  assert.deepEqual(m.calls[2].body,{sport:'ufc',season:'2023',cost:200,acceptPriceChanges:false});
});
test('server-provided free price is supported with a zero balance', async () => {
  const m=mock({balance:0,cost:0}), a=account(); const result=await openPack(a,'nfl',0,m.request);
  assert.equal(result.cost,0);assert.equal(a.balance,0);assert.equal(m.calls[2].body.cost,0);
});
test('malformed successful response is marked uncertain', async () => {
  const m = mock({ malformed: true });
  await assert.rejects(openPack(account(),'nfl',200,m.request), e => e.uncertain === true);
});
test('Windows vault encrypts and recovers secrets; restart locks unfinished purchase', { skip: process.platform !== 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'real-manager-test-'));
  const s = new Store(dir); await s.load(); s.accounts.set('alpha', account());
  await s.saveAccounts();
  const ciphertext = await fs.readFile(path.join(dir,'accounts.dpapi'));
  assert.ok(!ciphertext.includes(Buffer.from('secret-alpha')));
  s.jobs.push({ type:'open',status:'running',items:[{accountId:'alpha',status:'running'}] });
  await s.saveHistory();
  const restored = new Store(dir); await restored.load();
  assert.equal(restored.accounts.get('alpha').headers['real-auth-info'],'secret-alpha');
  assert.equal(restored.accounts.get('alpha').purchaseHold,true);
  assert.equal(restored.jobs[0].items[0].status,'uncertain');
  await restored.saveAccounts();
  const twice = new Store(dir); await twice.load(); assert.equal(twice.accounts.get('alpha').purchaseHold,true);
  await fs.unlink(path.join(dir,'accounts.dpapi')); await fs.unlink(path.join(dir,'history.json')); await fs.rmdir(dir);
});
