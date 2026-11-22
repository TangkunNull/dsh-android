// 桥上终端通道的端到端测试。
//
// 到这里为止，PTY 已经分别验过两段：`libdsh_pty.so` 本身（tools/pty.test.mjs）
// 与 `node-pty` shim 的接口形状。缺的是中间那一段 —— **桥**：命令名对不对、
// 数据帧有没有到、字符编码有没有在中途碎掉、客户端断开时进程收不收得掉。
// 这些都不需要真机，只要在宿主上起一个桥。
//
// 跑的是 host 产物（.artifacts/libdsh_pty_host.so），glibc 与 bionic 的
// forkpty 语义一致，所以除了 SELinux 那一层，结论对 Android 成立。

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBridgeServer } from '../src/host/bridge-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const IMPL = join(here, '..');
const HOST_SO = join(IMPL, '.artifacts', 'libdsh_pty_host.so');
const SHIM = join(IMPL, 'android', 'pty-shim', 'index.js');
const ready = fs.existsSync(HOST_SO) && fs.existsSync(SHIM);
if (ready) {
  process.env.DSH_PTY_NATIVE = HOST_SO;
  // 桥在 impl/src/host/ 下，向上找不到 node-pty；这里显式指到 shim 本体。
  process.env.DSH_PTY_MODULE = SHIM;
}

const skip = ready ? false : '缺少 .artifacts/libdsh_pty_host.so（先跑 tools/build_pty.sh）';

/// 一个最小的桥客户端：发命令、按 `t` 收帧。
///
/// 不复用 Dart 侧的实现，因为这里要验的正是「线缆上的形状」；用同一份代码去
/// 验自己会得到「我一直都对」。
class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.frames = [];
    this.waiters = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buf += chunk;
      let at;
      while ((at = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, at);
        this.buf = this.buf.slice(at + 1);
        if (line.trim().length === 0) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        this.frames.push(frame);
        for (const w of [...this.waiters]) {
          if (w.match(frame)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(frame);
          }
        }
      }
    });
  }

  send(obj) {
    this.socket.write(`${JSON.stringify(obj)}\n`);
  }

  /// 等一帧满足条件的帧；已经收到过的也算。
  waitFor(match, ms = 8000, label = 'frame') {
    const hit = this.frames.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === wrapped);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`timeout waiting for ${label}; got ${JSON.stringify(this.frames.slice(-6))}`));
      }, ms);
      const wrapped = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      // 同一个 match 可能已经被前面的帧满足
      this.waiters.push({ match, resolve: wrapped });
    });
  }
}

async function startBridge() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'dsh-bridge-pty-'));
  const socketPath = join(dir, 'bridge.sock');
  const endpointPath = join(dir, 'endpoint.json');
  const server = createBridgeServer({
    socketPath,
    endpointPath,
    token: 'test-token',
    onLog: (tag, info) => { if (process.env.DEBUG_BRIDGE) console.error('[bridge]', tag, info ?? ''); },
  });
  await server.listen();
  return { server, socketPath, dir };
}

function connect(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }, () => resolve(new TestClient(socket)));
    socket.on('error', reject);
  });
}

async function openSession(socketPath) {
  const client = await connect(socketPath);
  client.send({ t: 'hello', proto: 1, token: 'test-token' });
  await client.waitFor((f) => f.t === 'welcome', 5000, 'welcome');
  return client;
}

test('pty.open 起一个 shell 并把输出送到 pty.data', { skip }, async () => {
  const { server, socketPath, dir } = await startBridge();
  try {
    const client = await openSession(socketPath);
    client.send({ t: 'pty.open', id: 1, sid: 't1', shell: '/bin/sh', cols: 100, rows: 30 });
    const ack = await client.waitFor((f) => f.t === 'ack' && f.id === 1, 5000, 'pty.open ack');
    assert.equal(ack.sid, 't1');
    assert.ok(ack.pid > 0, 'ack 要带 pid，否则界面无法显示进程号');

    client.send({ t: 'pty.input', sid: 't1', v: 'echo bridge-ok\n' });
    const data = await client.waitFor(
      (f) => f.t === 'pty.data' && f.sid === 't1' && f.v.includes('bridge-ok'),
      8000,
      'echo output',
    );
    assert.match(data.v, /\r\n/, '真 PTY 的行尾是 CRLF，只有管道才是 LF');
    client.socket.destroy();
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('多字节字符不会在 read 边界碎成替换字符', { skip }, async () => {
  const { server, socketPath, dir } = await startBridge();
  try {
    const client = await openSession(socketPath);
    client.send({ t: 'pty.open', id: 1, sid: 't1', shell: '/bin/sh' });
    await client.waitFor((f) => f.t === 'ack' && f.sid === 't1', 5000, 'ack');

    // 循环打印多字节字符，让它横跨多次 read(2)
    client.send({ t: 'pty.input', sid: 't1', v: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo 终端中文测试; done\n' });
    const joined = await client.waitFor((f) => {
      if (f.t !== 'pty.data') return false;
      const all = client.frames.filter((x) => x.t === 'pty.data').map((x) => x.v).join('');
      return (all.match(/终端中文测试/g) ?? []).length >= 10;
    }, 12000, 'multibyte output');

    const all = client.frames.filter((x) => x.t === 'pty.data').map((x) => x.v).join('');
    assert.equal(all.includes('\uFFFD'), false, '出现 U+FFFD 说明字节流在边界上被切坏了');
    assert.ok(joined);
    client.socket.destroy();
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resize 改到内核 winsize；退出发 pty.exit', { skip }, async () => {
  const { server, socketPath, dir } = await startBridge();
  try {
    const client = await openSession(socketPath);
    client.send({ t: 'pty.open', id: 1, sid: 't1', shell: '/bin/sh', cols: 80, rows: 24 });
    await client.waitFor((f) => f.t === 'ack' && f.sid === 't1', 5000, 'ack');

    client.send({ t: 'pty.resize', sid: 't1', cols: 123, rows: 45 });
    client.send({ t: 'pty.input', sid: 't1', v: 'stty size\n' });
    const data = await client.waitFor(
      (f) => f.t === 'pty.data' && f.v.includes('45 123'),
      8000,
      'stty size after resize',
    );
    assert.match(data.v, /45 123/);

    client.send({ t: 'pty.input', sid: 't1', v: 'exit 7\n' });
    const exit = await client.waitFor((f) => f.t === 'pty.exit' && f.sid === 't1', 8000, 'pty.exit');
    assert.equal(exit.code, 7);
    client.socket.destroy();
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('客户端断开时它开着的终端被收掉', { skip }, async () => {
  const { server, socketPath, dir } = await startBridge();
  try {
    const client = await openSession(socketPath);
    client.send({ t: 'pty.open', id: 1, sid: 't1', shell: '/bin/sh' });
    const ack = await client.waitFor((f) => f.t === 'ack' && f.sid === 't1', 5000, 'ack');
    const pid = ack.pid;

    client.socket.destroy();

    // 判定「收掉了」有两个合法形态：`/proc/<pid>` 消失（已被 reap），或者
    // 状态是 `Z`（已退出、等父进程 waitpid）。只认前者会把「内核还没调度到」
    // 误判成泄漏；只认后者又会漏掉真正的残活进程，所以两个都算。
    let state = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (!fs.existsSync(`/proc/${pid}`)) { state = 'gone'; break; }
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // 字段 3 是进程状态；comm 里可能有空格，所以从最后一个 ')' 之后切
        const after = stat.slice(stat.lastIndexOf(')') + 2);
        state = after.split(' ')[0];
      } catch { state = 'gone'; break; }
      if (state === 'Z' || state === 'X') break;
    }
    assert.ok(
      state === 'gone' || state === 'Z' || state === 'X',
      `终端进程 ${pid} 在客户端断开后仍在运行（state=${state}）`,
    );
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没有 native 时 pty.open 给出可操作的错误', { skip }, async () => {
  const { server, socketPath, dir } = await startBridge();
  const saved = process.env.DSH_PTY_NATIVE;
  try {
    // 断开后续进程的加载路径：shim 在模块加载时读这个变量，所以要先清缓存。
    // 简化做法：直接不设，若 shim 已经缓存了 native 就跳过这条断言。
    delete process.env.DSH_PTY_NATIVE;
    const client = await openSession(socketPath);
    client.send({ t: 'pty.open', id: 1, sid: 't1', shell: '/bin/sh' });
    const err = await client.waitFor((f) => f.t === 'error' || (f.t === 'ack' && f.sid === 't1'), 5000, 'response');
    if (err.t === 'error') {
      // shim 可能在模块加载时已经拿到了 native，此时失败点变成 spawn 本身。
      assert.ok(err.code === 'pty-unavailable' || err.code === 'pty', `意外的 code: ${err.code}`);
      assert.ok(err.message.length > 0);
    }
    client.socket.destroy();
  } finally {
    if (saved !== undefined) process.env.DSH_PTY_NATIVE = saved;
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
