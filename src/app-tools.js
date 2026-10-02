import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import metadata from '../package.json' with { type: 'json' };

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export function configuredDot(config) {
  if (config?.mode !== 'dot' || !config.dot?.name || !config.dot?.threadId || config.dot.hostId !== 'durable') {
    throw new Error('请先运行 connect-dot --name NAME 连接现有 Dot；本版本不支持独立 Codex 会话。');
  }
  return config.dot;
}
export async function verifyDot(dot, app = new AppTools()) {
  try {
    await app.start();
    const result = await app.call('read_thread', { threadId: dot.threadId, hostId: dot.hostId, turnLimit: 1, maxOutputCharsPerItem: 100 });
    if (result.thread?.id !== dot.threadId) throw new Error('无法验证 Dot 主对话。');
  } finally { app.close(); }
}
export function resolveDot(name) {
  const state = JSON.parse(fs.readFileSync(path.join(codexHome(), '.codex-global-state.json'), 'utf8'));
  const atoms = state['electron-persisted-atom-state'] || {};
  const primary = atoms['primary-aeon-selection-v1']?.response;
  const selection = primary?.selection;
  const profile = primary?.profile || atoms['cloud-aeon-sidebar-cache-v1']?.profilesByThreadId?.[selection?.thread_id];
  if (!selection?.available || !selection.thread_id || profile?.display_name?.toLowerCase() !== name.toLowerCase()) {
    throw new Error('当前主 Dot 与指定名称不匹配；请先在 Codex 打开该 Dot，然后重试。');
  }
  return { name: profile.display_name, threadId: selection.thread_id, hostId: 'durable', roomId: selection.messaging_room_id, dotId: selection.aeon_id };
}
export function findAppToolsServer() {
  const root = path.join(codexHome(), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  const candidates = fs.readdirSync(root).map(v => path.join(root, v, 'server.mjs')).filter(p => fs.existsSync(p));
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!candidates[0]) throw new Error('缺少 Codex 自带的 app-tools 服务。');
  return candidates[0];
}
export class AppTools {
  constructor({ spawnImpl = spawn, serverPath, callerThreadId = process.env.CODEX_THREAD_ID } = {}) {
    this.spawn = spawnImpl; this.serverPath = serverPath; this.callerThreadId = callerThreadId;
    this.pending = new Map(); this.nextId = 0;
  }
  async start() {
    if (this.child) return;
    if (!process.env.CODEX_APP_TOOLS_PIPE_PATH || !this.callerThreadId) throw new Error('Dot 模式需从 Codex 桌面对话启动，并保持 Codex 应用运行。');
    const child = this.spawn(process.execPath, [this.serverPath || findAppToolsServer()], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; child.stderr.resume();
    const lost = () => { if (this.child === child) { this.child = null; this.fail(new Error('Codex 桌面工具连接已中断。')); } };
    child.on('exit', lost); child.on('error', lost); child.stdin.on('error', lost);
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer); this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`Codex 桌面工具请求失败（${message.error.code}）。`));
      else waiter.resolve(message.result);
    });
    try {
      await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wedot', version: metadata.version } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const catalog = await this.rpc('tools/list', {});
      for (const required of ['read_thread', 'send_message_to_thread', 'wait_threads']) {
        if (!catalog.tools.some(tool => tool.name === required)) throw new Error(`Codex 未提供 ${required}。`);
      }
    } catch (error) { this.close(); throw error; }
  }
  rpc(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 桌面工具响应超时；结果未确认，未自动重放。')); }, 55000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async call(name, args) {
    if (!['read_thread', 'send_message_to_thread', 'wait_threads'].includes(name)) throw new Error('WeDot 不允许调用此桌面工具。');
    const result = await this.rpc('tools/call', { name, arguments: args, _meta: { 'openai/threadId': this.callerThreadId } });
    if (result.isError) throw new Error(`Codex 桌面工具 ${name} 未成功。`);
    const text = result.content?.find(item => item.type === 'text')?.text;
    if (typeof text !== 'string') throw new Error('Codex 桌面工具未返回可解析结果。');
    return JSON.parse(text);
  }
  fail(error) {
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  close() {
    const child = this.child; this.child = null;
    this.fail(new Error('Dot 转发已停止。'));
    this.lines?.close(); child?.stdin.destroy(); child?.kill();
  }
}
