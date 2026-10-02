import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { dataDir, prepareDir, readJSON, writeJSON, readLock, acquireLock, Store } from './storage.js';
import { WeixinAPI, trustedBase, ApiError } from './weixin.js';
import { DotBridge } from './dot.js';
import { resolveDot, configuredDot, verifyDot } from './app-tools.js';
import metadata from '../package.json' with { type: 'json' };

const ownFile = fileURLToPath(import.meta.url);
const statusFile = path.join(dataDir, 'status.json');
const stopFile = path.join(dataDir, 'stop.json');
const qrFile = path.join(dataDir, 'login.png');
function print(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function status() {
  const store = new Store(); const lock = readLock(); const detail = readJSON(statusFile, {});
  return store.status({ running: !!lock, process: lock?.pid || null,
    state: lock ? detail.state || 'starting' : ['bound', 'error', 'login_required'].includes(detail.state) ? detail.state : 'stopped',
    message: detail.message || '', heartbeat: detail.heartbeat || null, qrPath: lock && detail.state === 'waiting_scan' ? qrFile : undefined,
    lastReplyAt: detail.lastReplyAt || null,
    lastForwardAt: detail.lastForwardAt || null, warning: detail.warning || null,
    workerVersion: lock ? detail.version || 'legacy' : null,
    dotConnection: detail.dotConnection || null, dotError: detail.dotError || null,
    lastDotCheckAt: detail.lastDotCheckAt || null, lastReceiveAt: detail.lastReceiveAt || null,
    lastCommand: detail.lastCommand || null, lastCommandAt: detail.lastCommandAt || null, lastCommandReplyAt: detail.lastCommandReplyAt || null,
    lastSendAt: detail.lastSendAt || null, lastSendError: detail.lastSendError || null, lastSendErrorAt: detail.lastSendErrorAt || null,
    lastPollAt: detail.lastPollAt || null, lastPollMessageCount: detail.lastPollMessageCount ?? null, wechatConnection: detail.wechatConnection || null,
  });
}
async function launch(mode) {
  if (readLock()) throw new Error('WeDot 已有运行进程，请先用 status 查看，或 stop 后重新连接。');
  fs.rmSync(statusFile, { force: true });
  const log = fs.openSync(path.join(dataDir, 'worker.log'), 'w', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [ownFile, mode], { detached: true, windowsHide: true, stdio: ['ignore', log, log], shell: false, cwd: dataDir });
  } finally { fs.closeSync(log); }
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  for (let i = 0; i < 100; i++) {
    const detail = readJSON(statusFile);
    if (detail && !['starting', 'listening'].includes(detail.state)) return status();
    if (child.exitCode !== null) throw new Error('后台进程未能保持运行，请检查运行目录中的 worker.log。');
    await delay(200);
  }
  return status();
}
async function worker(mode) {
  const lock = acquireLock(); const controller = new AbortController(); const store = new Store();
  let current = { state: 'starting', message: '正在启动。', pid: process.pid, version: metadata.version };
  const report = value => { current = { ...current, ...value, heartbeat: new Date().toISOString() }; writeJSON(statusFile, current); };
  report({});
  const tick = setInterval(() => {
    if (readJSON(stopFile)?.nonce === lock.nonce) controller.abort();
    report({});
  }, 500);
  const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (mode === '_login') {
      const api = new WeixinAPI(); const qr = await api.qr();
      if (typeof qr.qrcode !== 'string' || typeof qr.qrcode_img_content !== 'string') throw new Error('微信未返回有效登录二维码。');
      await QRCode.toFile(qrFile, qr.qrcode_img_content, { width: 420, margin: 3 });
      report({ state: 'waiting_scan', message: '请用微信扫描二维码并在手机上确认；二维码最多等待 8 分钟。' });
      const deadline = Date.now() + 8 * 60 * 1000;
      while (Date.now() < deadline && !controller.signal.aborted) {
        let result;
        try { result = await api.qrStatus(qr.qrcode, controller.signal); }
        catch (error) { if (error.name === 'TimeoutError') continue; throw error; }
        if (result.status === 'expired') throw new Error('微信二维码已过期，请再次 login。');
        if (result.status === 'confirmed') {
          if (!result.bot_token || !result.ilink_bot_id || !result.ilink_user_id) throw new Error('微信未返回完整身份信息，未启用通道。');
          store.value.credentials = { botToken: result.bot_token, accountId: result.ilink_bot_id, userId: result.ilink_user_id, apiBaseUrl: trustedBase(result.baseurl || api.base) };
          store.value.cursor = ''; store.value.seen = []; store.value.inbox = [];
          delete store.value.dotSync;
          store.save();
          report({ state: 'bound', message: '微信绑定成功。运行 start 即可开始对话。' }); return;
        }
        await delay(1000, undefined, { signal: controller.signal });
      }
      if (!controller.signal.aborted) throw new Error('扫码等待超时，请再次 login。');
    } else {
      configuredDot(store.value.config);
      if (!store.value.credentials?.userId) throw new Error('请先扫码绑定微信。');
      report({ state: 'listening', message: '等待微信消息。' });
      await new DotBridge(store, { report }).run(controller.signal);
    }
  } catch (error) {
    if (!controller.signal.aborted) report({ state: error instanceof ApiError && error.code === -14 ? 'login_required' : 'error', message: error instanceof ApiError && error.code === -14 ? '微信登录已失效，请重新扫码。' : error instanceof Error && !/fetch|network|JSON/i.test(error.message) ? error.message : '连接失败，请检查网络后重试。' });
  } finally {
    clearInterval(tick); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (controller.signal.aborted) report({ state: 'stopped', message: 'WeDot 已停止。' });
    fs.rmSync(qrFile, { force: true }); lock.release();
  }
}
async function main() {
  const [command = 'status', ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) return print({ version: metadata.version, commands: ['connect-dot --name NAME', 'doctor', 'login', 'start', 'status', 'stop', 'logout'], mode: 'dot' });
  if (['version', '--version', '-v'].includes(command)) return print({ version: metadata.version });
  if (command !== 'connect-dot' && args.length) throw new Error('此命令不接受额外参数，请运行 help 查看用法。');
  prepareDir();
  if (command.startsWith('_')) { if (!['_login', '_bridge'].includes(command)) throw new Error('Unknown worker mode'); return worker(command); }
  if (command === 'status') return print(status());
  if (command === 'stop') {
    const lock = readLock();
    if (lock) {
      writeJSON(stopFile, { nonce: lock.nonce });
      for (let i = 0; i < 40 && readLock(); i++) await delay(200);
    }
    return print(status());
  }
  const store = new Store();
  if (command === 'connect-dot') {
    if (readLock()) throw new Error('切换对话前请先 stop。');
    if (args.length !== 2 || args[0] !== '--name' || !args[1]) throw new Error('用法：connect-dot --name NAME');
    const dot = resolveDot(args[1]);
    await verifyDot(dot);
    if (store.value.config.dot?.threadId !== dot.threadId) delete store.value.dotSync;
    store.value.config = { ...store.value.config, mode: 'dot', dot };
    store.save(); return print(store.status());
  }
  if (command === 'doctor') {
    const dot = configuredDot(store.value.config);
    await verifyDot(dot);
    return print({ mode: 'dot', dot: dot.name, desktopTools: 'ok', threadVerified: true });
  }
  if (command === 'login') return print(await launch('_login'));
  if (command === 'start') {
    configuredDot(store.value.config);
    if (!store.value.credentials?.userId) throw new Error('请先 login 并用微信扫码确认。');
    return print(await launch('_bridge'));
  }
  if (command === 'logout') {
    if (readLock()) throw new Error('请先 stop，再退出登录。');
    store.value.credentials = null; store.value.cursor = ''; store.value.seen = []; store.value.inbox = []; delete store.value.dotSync; store.save();
    fs.rmSync(statusFile, { force: true });
    return print({ bound: false, message: '本地微信凭证已删除；此操作不会代替微信端撤销授权。' });
  }
  throw new Error('本版本仅支持 Dot。命令：connect-dot --name NAME、doctor、login、start、status、stop、logout、help');
}
main().catch(error => { print({ error: error.message }); process.exitCode = 1; });
