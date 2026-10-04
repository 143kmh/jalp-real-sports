import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS, validateSettings } from './automation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function protect(mode, bytes) {
  if (process.platform !== 'win32') throw new Error('Хранилище этой версии использует Windows DPAPI.');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'vault.ps1'), '-Mode', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let finished = false;
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', d => output.push(d));
    child.stderr.on('data', () => {});
    child.on('error', () => { if (!finished) { finished = true; clearTimeout(timer); reject(new Error('Не удалось запустить Windows DPAPI.')); } });
    child.on('exit', code => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (code !== 0) reject(new Error('Windows не смог прочитать/зашифровать хранилище. Запускайте под тем же Windows-пользователем.'));
      else resolve(Buffer.from(Buffer.concat(output).toString().trim(), 'base64'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes.toString('base64'));
  });
}

export class Store {
  constructor(directory) { this.directory = directory; this.accounts = new Map(); this.events = []; this.jobs = []; this.settings=validateSettings(DEFAULT_SETTINGS); }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try{this.settings=validateSettings(JSON.parse(await fs.readFile(path.join(this.directory,'settings.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
    try {
      const sealed = await fs.readFile(path.join(this.directory, 'accounts.dpapi'));
      const plain = await protect('unprotect', sealed);
      const accounts = JSON.parse(plain.toString('utf8'));
      this.accounts = new Map(accounts.map(a => [a.id, a]));
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try {
      const state = JSON.parse(await fs.readFile(path.join(this.directory, 'history.json'), 'utf8'));
      this.events = state.events || []; this.jobs = state.jobs || [];
      for (const job of this.jobs) if (['queued', 'running'].includes(job.status)) {
        job.status = 'interrupted';
        for (const item of job.items) if (['queued', 'running'].includes(item.status)) {
          item.status = item.status === 'running' && ['open','max','player'].includes(job.type) ? 'uncertain' : 'cancelled';
          item.message = 'Приложение перезапущено. Проверьте результат в Real; автоматического повтора нет.';
          if (item.status === 'uncertain' && this.accounts.has(item.accountId)) this.accounts.get(item.accountId).purchaseHold = true;
        }
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async saveAccounts() {
    const plain=Buffer.from(JSON.stringify([...this.accounts.values()]));
    this.accountsWrite=(this.accountsWrite||Promise.resolve()).catch(()=>{}).then(()=>this.writeAccounts(plain));
    return this.accountsWrite;
  }
  async writeAccounts(plain){
    const encrypted = await protect('protect', plain);
    const target = path.join(this.directory, 'accounts.dpapi');
    await fs.writeFile(`${target}.tmp`, encrypted);
    await fs.rename(`${target}.tmp`, target);
  }
  async saveHistory() {
    const target = path.join(this.directory, 'history.json');
    await fs.writeFile(`${target}.tmp`, JSON.stringify({ events: this.events.slice(-300), jobs: this.jobs.slice(-40) }, null, 2));
    await fs.rename(`${target}.tmp`, target);
  }
  async saveSettings(value){
    const settings=validateSettings(value),target=path.join(this.directory,'settings.json');
    await fs.writeFile(`${target}.tmp`,JSON.stringify(settings,null,2));await fs.rename(`${target}.tmp`,target);this.settings=settings;
  }
}
