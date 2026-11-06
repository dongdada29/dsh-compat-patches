import { realpath } from 'node:fs/promises';
import { assertIdle } from './manager.mjs';

function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Inspector 只允许无凭据的 http://127.0.0.1:<port> 地址。');
  return url;
}

async function connect(address) {
  const url = endpoint(address);
  const response = await fetch(new URL('/json/list', url), { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error(`Inspector 返回 HTTP ${response.status}`);
  const list = await response.json();
  const candidate = list.find(item => item.url === 'dsh://host');
  if (!candidate) throw new Error('未找到 DSH Host Inspector。');
  const socketUrl = new URL(candidate.webSocketDebuggerUrl);
  if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== url.hostname || socketUrl.port !== url.port || socketUrl.username || socketUrl.password) throw new Error('Inspector 返回了不同主机的 WebSocket，停止连接。');
  const socket = new WebSocket(socketUrl);
  const pending = new Map();
  let serial = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id); clearTimeout(waiting.timer);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  });
  const fail = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Inspector 连接中断；请检查状态后再决定是否重试。')); }
    pending.clear();
  };
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspector 连接超时。')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector 不可用。')); }, { once: true });
    });
  } catch (error) { socket.close(); throw error; }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 等待超时；操作结果未知，先检查运行时状态。`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { call, close: () => { fail(); socket.close(); } };
}

function hostContext(document) {
  const host = document.children?.find(node => node.nodeName.toLowerCase() === 'host');
  const context = host?.children?.find(node => node.nodeName.toLowerCase() === 'context');
  if (!context) throw new Error('Inspector 没有提供 Host Context。');
  return context.nodeId;
}

function stateOfRuntime() {
  const profile = this.get('profileContext')?.dir;
  const canonical = profile && process.getBuiltinModule('fs').realpathSync(profile);
  const entries = [...this.get('loader').entries()].filter(entry => entry.options.name === 'ds-bot');
  const method = Object.getOwnPropertyDescriptor(this.get('systemPrompt'), 'assemble')?.value;
  const compatible = typeof method === 'function' && method.name === 'compatible' && method.toString().includes('hidden.has(tool.name)');
  return { profile: canonical, active: entries.length > 0 && entries.every(entry => entry.fiber?.state === 2) && compatible, entries: entries.map(entry => ({ id: entry.id, state: entry.fiber?.state })), hmr: !!this.get('hmr') };
}

/** Use the already-enabled loopback Inspector; never starts one or changes its permissions. */
export async function activate(options, { checkOnly = false } = {}) {
  let client;
  try { client = await connect(options.inspectorUrl ?? 'http://127.0.0.1:9230'); }
  catch (error) { return { activation: 'restart-required', active: false, reason: error.message }; }
  try {
    const { root } = await client.call('DOM.getDocument', { depth: 3 });
    const { object } = await client.call('DOM.resolveNode', { nodeId: hostContext(root) });
    const invoke = async (fn, values = []) => {
      const result = await client.call('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn.toString(), arguments: values.map(value => ({ value })), returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    };
    const expected = await realpath(options.profile);
    const before = await invoke(stateOfRuntime);
    if (before.profile !== expected) throw new Error('Inspector 属于另一个 profile，拒绝操作。');
    if (before.active) return { ...before, activation: 'active', changed: false };
    if (checkOnly) return { ...before, activation: 'not-loaded' };
    if (!before.hmr || before.entries.length === 0) return { ...before, activation: 'restart-required', reason: '此运行时未提供可热重载的 DS-Bot。' };
    await assertIdle(options.profile);
    const result = await invoke(async function (profile) {
      const fs = process.getBuiltinModule('fs');
      const path = process.getBuiltinModule('path');
      const home = path.dirname(path.dirname(profile));
      const pendingFile = path.join(home, 'bot/inflight.json');
      if (fs.existsSync(pendingFile)) {
        const current = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
        if (Object.keys(current.turns ?? {}).length || Object.keys(current.queued ?? {}).length) throw new Error('Bot 任务尚未结束，拒绝热重载。');
      }
      const hmr = this.get('hmr');
      const ids = [...this.get('loader').entries()].filter(entry => entry.options.name === 'ds-bot').map(entry => entry.id);
      return hmr.runExclusive(() => hmr.reconcileProfile(ids));
    }, [expected]);
    const after = await invoke(stateOfRuntime);
    return { ...after, activation: after.active ? 'active' : 'restart-required', changed: true, reconciliation: result };
  } finally { client.close(); }
}
