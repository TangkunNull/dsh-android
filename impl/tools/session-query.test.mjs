// `@dsh-android/session-query` 的契约测试：无 SQLite 的会话全文搜索。
//
// 为什么单独测而不是靠端到端：整条 profile 起来要 libnode 的 zstd，本机 Node 22
// 没有；而这里要证明的东西与启动无关 —— 只要 `searchSessions` / `searchEvents`
// 的**返回形状**能被 `dsh-tool-session-query` 吃下去，Android 上就没有别的变量了
// （这个实现除了读语料，不碰任何平台能力）。
//
// 依赖来自 `DSH_MODULES`（默认 `/tmp/dshcli/node_modules`）。没有依赖时整组 skip：
// 一个只在装了完整闭包的机器上才跑的测试，好过一个把 CI 弄红的测试。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const IMPL = join(here, '..');
const MODULES = process.env.DSH_MODULES ?? '/tmp/dshcli/node_modules';

const ENGINE_PATH = join(IMPL, 'android', 'session-query', 'index.js');
const CORDIS_PATH = join(MODULES, '@deepseek-ai', 'cordis', 'lib', 'index.js');
const BASE_PATH = join(MODULES, '@deepseek-ai', 'dsh-session-query', 'lib', 'index.js');

const ready = existsSync(ENGINE_PATH) && existsSync(CORDIS_PATH) && existsSync(BASE_PATH);
const skip = ready ? false : '缺少 dsh 闭包（设 DSH_MODULES 指到 node_modules）';

/// 一条最小但合法的会话日志。
///
/// `surfaceOp` 不是可选装饰：`buildSessionEventSearchDocuments` 会做一次 surface
/// 折叠，凡 surface-eligible 的事件（user/assistant/system/tool-result）都必须带
/// 这个标记，否则抛 `SESSION_QUERY_INVALID_SURFACE`。真实日志由 `wireEvent` 补上。
function makeLog(t, text) {
  return makeLogMulti(t, [text]);
}

/// 一个会话里跑多个 turn。seq 必须连续，否则 surface 折叠会拒绝。
function makeLogMulti(t, texts) {
  const events = [];
  let seq = 0;
  for (const text of texts) {
    events.push(
      { seq: seq++, type: 'turn/start', time: t, data: {} },
      { seq: seq++, type: 'user/message', time: t, surfaceOp: 'append', data: { content: [{ type: 'text', text }] } },
      { seq: seq++, type: 'step/start', time: t, data: {} },
      {
        seq: seq++,
        type: 'assistant/message',
        time: t,
        surfaceOp: 'append',
        data: { message: { content: [{ type: 'text', text: '收到，先看 jniLibs 里的东西。' }] } },
      },
      { seq: seq++, type: 'step/end', time: t, data: {} },
      { seq: seq++, type: 'turn/end', time: t, data: { reason: { kind: 'completed' } } },
    );
  }
  return events;
}

let Engine;
let Context;

if (ready) {
  const engineModule = await import(pathToFileURL(ENGINE_PATH).href);
  Engine = engineModule.default;
  const cordisModule = await import(pathToFileURL(CORDIS_PATH).href);
  Context = cordisModule.Context;
}

/// 造一个引擎 + 一份 fake sessions service。`ctx.sessions` 是基类唯一的依赖。
function makeEngine(sessions) {
  const ctx = new Context();
  ctx.provide('sessions', {
    list: () => [...sessions.values()],
    get: (id) => sessions.get(id),
  });
  return new Engine(ctx, {});
}

function makeSession(id, createdAt, events) {
  return {
    id,
    header: { id, version: 1, createdAt, cwd: '/data/workspace' },
    inheritedEventCount: 0,
    snapshotEvents: () => events.map((e) => structuredClone(e)),
  };
}

const T = 1731000000000;

test('searchSessions 命中会话并返回 bestMatch', { skip }, async () => {
  const sessions = new Map();
  sessions.set('s1', makeSession('s1', T, makeLog(T, '帮我看一下 ripgrep 怎么装')));
  const engine = makeEngine(sessions);

  const page = await engine.searchSessions({ query: 'ripgrep', limit: 5 });
  assert.equal(page.items.length, 1);
  const hit = page.items[0];
  assert.equal(hit.header.id, 's1');
  assert.equal(hit.live, true, 'live 会话必须标成 live');
  assert.equal(hit.persisted, false);
  assert.equal(hit.bestMatch.seq, 1, '先命中用户那句，而不是后面的助手回复');
  assert.match(hit.bestMatch.snippet, /ripgrep/);
  assert.equal(hit.bestMatch.surface, 'current');
  assert.equal(page.nextCursor, undefined);
});

test('searchSessions 不分词：缺一个词就不算命中', { skip }, async () => {
  const sessions = new Map();
  sessions.set('s1', makeSession('s1', T, makeLog(T, '帮我看一下 ripgrep 怎么装')));
  const engine = makeEngine(sessions);

  const both = await engine.searchSessions({ query: 'ripgrep jniLibs', limit: 5 });
  // 两个词分散在两条消息里，AND 语义下仍应命中（同一会话内任一条含两词才算）
  assert.equal(both.items.length, 0, '没有任何单条事件同时含这两个词');

  const one = await engine.searchSessions({ query: 'jniLibs', limit: 5 });
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0].bestMatch.seq, 3);
});

test('searchSessions 大小写不敏感，且按命中数排序', { skip }, async () => {
  const sessions = new Map();
  sessions.set('a', makeSession('a', T, makeLog(T, 'RIPGREP 一次')));
  sessions.set('b', makeSession('b', T + 1000, makeLogMulti(T, ['ripgrep 第一次', 'ripgrep 第二次'])));
  const engine = makeEngine(sessions);

  const page = await engine.searchSessions({ query: 'ripgrep', limit: 5 });
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].header.id, 'b', '命中多的排前面，与创建时间无关');
  assert.equal(page.items[1].header.id, 'a');
});

test('searchEvents 返回事件级命中与 snippet', { skip }, async () => {
  const sessions = new Map();
  sessions.set('s1', makeSession('s1', T, makeLog(T, '帮我看一下 ripgrep 怎么装')));
  const engine = makeEngine(sessions);

  const page = await engine.searchEvents({ sessionId: 's1', query: 'jniLibs', limit: 5 });
  assert.equal(page.session.id, 's1');
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].seq, 3);
  assert.equal(page.items[0].type, 'assistant/message');
  assert.match(page.items[0].snippet, /jniLibs/);
  assert.equal(page.items[0].surface, 'current');
});

test('searchEvents 对未知会话报 SESSION_QUERY_SESSION_NOT_FOUND', { skip }, async () => {
  const engine = makeEngine(new Map());
  await assert.rejects(
    () => engine.searchEvents({ sessionId: 'nope', query: 'x', limit: 5 }),
    (e) => e.code === 'SESSION_QUERY_SESSION_NOT_FOUND',
  );
});

test('查询为空或纯空白时拒绝，而不是返回全部', { skip }, async () => {
  const engine = makeEngine(new Map());
  for (const query of ['', '   ', undefined]) {
    await assert.rejects(
      () => engine.searchSessions({ query, limit: 5 }),
      (e) => e.code === 'SESSION_QUERY_INVALID_QUERY',
      `query=${JSON.stringify(query)} 应当被拒绝`,
    );
  }
});

test('limit 越界报错，默认值与 sqlite 版一致（20）', { skip }, async () => {
  const sessions = new Map();
  sessions.set('s1', makeSession('s1', T, makeLog(T, 'ripgrep')));
  const engine = makeEngine(sessions);

  assert.equal(engine._cfg.defaultLimit, 20);
  assert.equal(engine._cfg.maxLimit, 100);
  await assert.rejects(
    () => engine.searchSessions({ query: 'x', limit: 0 }),
    (e) => e.code === 'SESSION_QUERY_INVALID_LIMIT',
  );
  await assert.rejects(
    () => engine.searchSessions({ query: 'x', limit: 101 }),
    (e) => e.code === 'SESSION_QUERY_INVALID_LIMIT',
  );
});

test('分页游标：两次翻页不重叠，且游标不跨 scope 混用', { skip }, async () => {
  const sessions = new Map();
  for (let i = 0; i < 5; i++) {
    sessions.set(`s${i}`, makeSession(`s${i}`, T + i, makeLog(T, `ripgrep 第 ${i} 份`)));
  }
  const engine = makeEngine(sessions);

  const first = await engine.searchSessions({ query: 'ripgrep', limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor, '还有下一页时必须给游标');

  const second = await engine.searchSessions({ query: 'ripgrep', limit: 2, cursor: first.nextCursor });
  assert.equal(second.items.length, 2);
  const ids = new Set([...first.items, ...second.items].map((h) => h.header.id));
  assert.equal(ids.size, 4, '两页不能有重复会话');

  // 把 sessions 游标喂给 events 查询是调用方的 bug，必须报错而不是静默从 0 开始
  await assert.rejects(
    () => engine.searchEvents({ sessionId: 's0', query: 'ripgrep', limit: 2, cursor: first.nextCursor }),
    (e) => e.code === 'SESSION_QUERY_INVALID_CURSOR',
  );
});

test('坏会话被跳过，不拖垮整次搜索', { skip }, async () => {
  const sessions = new Map();
  sessions.set('good', makeSession('good', T, makeLog(T, 'ripgrep 在这里')));
  // surface 折叠会失败：assistant/message 缺 surfaceOp
  sessions.set('bad', {
    id: 'bad',
    header: { id: 'bad', version: 1, createdAt: T + 1 },
    inheritedEventCount: 0,
    snapshotEvents: () => [
      { seq: 0, type: 'turn/start', time: T, data: {} },
      { seq: 1, type: 'assistant/message', time: T, data: { message: { content: [{ type: 'text', text: 'ripgrep' }] } } },
      { seq: 2, type: 'turn/end', time: T, data: { reason: { kind: 'completed' } } },
    ],
  });
  const engine = makeEngine(sessions);

  const page = await engine.searchSessions({ query: 'ripgrep', limit: 5 });
  assert.equal(page.items.length, 1, '只有 good 进结果');
  assert.equal(page.items[0].header.id, 'good');
});

test('长文本的 snippet 截断且带省略号', { skip }, async () => {
  const long = `${'前'.repeat(400)}ripgrep${'后'.repeat(400)}`;
  const sessions = new Map();
  sessions.set('s1', makeSession('s1', T, makeLog(T, long)));
  const engine = makeEngine(sessions);

  const page = await engine.searchEvents({ sessionId: 's1', query: 'ripgrep', limit: 5 });
  const snippet = page.items[0].snippet;
  assert.ok(snippet.length <= 240, `snippet 长度 ${snippet.length} 超了 240`);
  assert.match(snippet, /ripgrep/, '截断后仍要包含命中词');
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), '两端都要有省略号');
});
