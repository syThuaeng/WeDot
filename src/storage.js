import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Keep the existing data location and lock so renaming does not reset login or start a second relay.
export const dataDir = process.env.CODEX_WECHAT_DATA || path.join(os.homedir(), '.codex-wechat-assistant');
export function prepareDir(dir = dataDir) {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const owner = execFileSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${owner}:(OI)(CI)F`], { stdio: 'pipe', windowsHide: true });
  }
}
export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function writeJSON(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export function readLock(dir = dataDir) {
  const lock = readJSON(path.join(dir, 'worker.lock'));
  return lock && alive(lock.pid) ? lock : null;
}
export function acquireLock(dir = dataDir) {
  const file = path.join(dir, 'worker.lock');
  const value = { pid: process.pid, nonce: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      return { ...value, release() { if (readJSON(file)?.nonce === value.nonce) fs.rmSync(file, { force: true }); } };
    } catch (e) {
      if (e.code !== 'EEXIST' || readLock(dir)) throw new Error('WeDot 已有运行进程，请先停止。');
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error('无法获取WeDot 进程锁。');
}
export class Store {
  constructor(dir = dataDir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.value = readJSON(this.file, { config: {}, credentials: null, cursor: '', seen: [], inbox: [] });
  }
  save() { writeJSON(this.file, this.value); }
  status(extra = {}) {
    const { config, credentials } = this.value;
    const dot = config.mode === 'dot' ? config.dot : null;
    return {
      bound: !!credentials, mode: 'dot', configured: !!dot?.threadId,
      permissions: 'Dot existing permissions',
      dot: dot?.name || null, dotThreadId: dot?.threadId || null,
      dotReplyReady: !!this.value.dotSync?.context,
      pendingDotReplies: (this.value.dotSync?.outbox || []).filter(m => !m.kind).length,
      pendingReplies: this.value.dotSync?.outbox?.length || 0,
      pendingMessages: this.value.inbox?.length || 0,
      accountId: credentials?.accountId || null, ownerBound: !!credentials?.userId,
      ...extra,
    };
  }
}
