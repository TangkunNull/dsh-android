/// 会话全文搜索的**无 SQLite** 实现。
///
/// 上游只有 `@deepseek-ai/dsh-session-query-sqlite` 一个 provider，它把搜索
/// 文档灌进 SQLite 的 FTS 表。Android 的 libnode 是 lite 构建，`readelf` 里
/// 一个 `sqlite3_*` 符号都没有，所以那条路在真机上必然 import 失败。
///
/// 但搜索本身不需要 SQLite：`@deepseek-ai/dsh-session-query` 的基类
/// `SessionQueryEngine` 已经是完整的 cordis Service，管着语料读取
/// （`listSessions` / `readSession` / `readEvent` / `filterSessions`）、标题与
/// 血缘追踪，**唯一缺的就是 `searchSessions` / `searchEvents`** —— 那两个是
/// sqlite 子类加的。基类还导出了 `buildSessionEventSearchDocuments` 与
/// `filterSessionEventDocuments` 这两个纯函数，它们正是 FTS 之前的那一步：
/// 把原始事件日志变成可搜索的文本单元。
///
/// 所以这里只做一件事：把「文档 → 匹配」用线性扫描补上。代价是每次搜索都要
/// 读一遍命中范围内的会话日志（sqlite 版命中索引），收益是零原生依赖 ——
/// 在几十个会话的量级上，这个代价是毫秒级。

import {
  SessionQueryEngine,
  SessionQueryError,
  buildSessionEventSearchDocuments,
  filterSessionEventDocuments,
  filterSessionResults,
  materializeSessionResultFilters,
  materializeSessionEventResultFilters,
} from '@deepseek-ai/dsh-session-query';

/// 上限与 SQLite 那条路保持同值：换 provider 不该让调用方的翻页行为变样。
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_SNIPPET_CHARS = 240;

function invalidQuery(message) {
  return new SessionQueryError(message, 'SESSION_QUERY_INVALID_QUERY');
}

/// 归一化查询串。空白折叠成单空格，NUL 拒绝（FTS 里的终止符语义）。
function normalizeQuery(value) {
  if (typeof value !== 'string') throw invalidQuery('session-search query must be text');
  const query = value.trim().replace(/\s+/gu, ' ');
  if (query.length === 0) throw invalidQuery('session-search query must contain non-whitespace text');
  if (query.includes('\0')) throw invalidQuery('session-search query must not contain NUL');
  return query;
}

function normalizeLimit(value, cfg) {
  const limit = value ?? cfg.defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cfg.maxLimit) {
    throw new SessionQueryError(
      `session-search limit must be an integer between 1 and ${cfg.maxLimit}`,
      'SESSION_QUERY_INVALID_LIMIT',
    );
  }
  return limit;
}

function invalidCursor(message) {
  return new SessionQueryError(`session-search cursor is invalid: ${message}`, 'SESSION_QUERY_INVALID_CURSOR');
}

/// 游标只是一个偏移量，但绑上 scope：把一个 events 游标喂给 sessions 查询是
/// 调用方的 bug，静默按 0 处理会让它拿到重复页并以为自己在翻页。
function encodeCursor(scope, offset) {
  return Buffer.from(JSON.stringify({ v: 1, scope, offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, scope) {
  if (cursor === undefined) return 0;
  if (typeof cursor !== 'string') throw invalidCursor('not text');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor('not base64url JSON');
  }
  if (parsed?.v !== 1 || parsed.scope !== scope) throw invalidCursor('wrong scope or version');
  if (!Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw invalidCursor('bad offset');
  return parsed.offset;
}

/// 把查询拆成词。与 FTS 的 `AND` 语义对齐：**每个词都要出现**，位置不限。
///
/// 这里刻意不做词干化与同义词：SQLite 的 porter tokenizer 在中文上本来就只
/// 做整串匹配，行为差异远小于「搜不到」的代价。少给能力比给错结果好。
function termsOf(query) {
  return query.split(' ').filter((t) => t.length > 0);
}

/// 大小写不敏感的定位。返回第一个词的位置（按 code point，不是 UTF-16 单元），
/// 拿不到就返回 -1 —— 有一个词不出现，整条就不匹配。
function firstMatchIndex(text, terms) {
  const lower = text.toLowerCase();
  let best = -1;
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at === -1) return -1;
    if (best === -1 || at < best) best = at;
  }
  if (best === -1) return -1;
  // UTF-16 下标 → code point 下标，否则含 emoji 的行会截在半个字符上
  return Array.from(text.slice(0, best)).length;
}

/// 匹配位置附近取一段，两端补省略号。窗口按 `maxChars` 的 1/3 前置，这样
/// 命中词不会贴着左边缘（那样看不出上下文）。
function makeSnippet(text, matchIndex, maxChars) {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const width = Math.max(1, maxChars - 2); // 两个省略号各占 1
  let start = Math.max(0, matchIndex - Math.floor(width / 3));
  if (matchIndex >= start + width) start = matchIndex - width + 1;
  const end = Math.min(chars.length, start + width);
  const head = start > 0 ? '…' : '';
  const tail = end < chars.length ? '…' : '';
  return head + chars.slice(start, end).join('') + tail;
}

function eventHit(sessionId, doc, terms, snippetChars) {
  return {
    sessionId,
    seq: doc.seq,
    type: doc.type,
    time: doc.time,
    surface: doc.surface,
    snippet: makeSnippet(doc.text, firstMatchIndex(doc.text, terms), snippetChars),
  };
}

/// 一页结果：多取一条判断「还有下一页」，避免 `total` 那种需要全量计数的字段。
function slicePage(all, offset, limit) {
  const items = all.slice(offset, offset + limit);
  return { items, hasMore: all.length > offset + limit };
}

export default class MemorySessionQueryEngine extends SessionQueryEngine {
  constructor(ctx, config = {}) {
    super(ctx, config);
    // 一个可观测标记：真机/桌面验收时用它确认「装配的确实是这个实现」，
    // 而不是根上那个 openAt:'never' 的 sqlite。
    globalThis.__DSH_SESSION_QUERY_IMPL__ = (globalThis.__DSH_SESSION_QUERY_IMPL__ ?? 0) + 1;
    const maxLimit = config?.maxLimit ?? MAX_LIMIT;
    this._cfg = {
      defaultLimit: Math.min(config?.defaultLimit ?? DEFAULT_LIMIT, maxLimit),
      maxLimit,
      snippetChars: config?.snippetChars ?? DEFAULT_SNIPPET_CHARS,
    };
  }

  /// 读一个会话的 header + 完整事件日志。
  ///
  /// 刻意不走 `readSession()`：那条路会 `Session.create(...)` 做一次完整
  /// replay 校验，而搜索只关心事件里的文本 —— 一个因为历史版本差异 replay
  /// 不过的会话，它的内容仍然应该能被搜到。语料读取本身（live 优先、回落到
  /// 持久化）由基类的 corpus 负责，这里只是把它拿出来。
  async _load(sessionId) {
    if (typeof this._corpus?.load === 'function') return this._corpus.load(sessionId);
    // 上游若把 corpus 收进 #private，回落到公开 API：代价是失去「坏会话不入
    // 结果集」的容错，而不是编译不过。
    const s = await this.readSession(sessionId);
    return { header: s.session, inheritedEventCount: s.inheritedEventCount, events: s.events };
  }

  /// 跨会话搜索。每个命中的会话只返回**最强的一个事件**（与 sqlite 版一致），
  /// 因为工具层问的是「这次搜索在哪些会话里有东西」。
  async searchSessions(request, exec) {
    const signal = exec?.signal;
    const query = normalizeQuery(request?.query);
    const terms = termsOf(query);
    const sessionFilters = materializeSessionResultFilters(request?.sessionFilters ?? []);
    const eventFilters = materializeSessionEventResultFilters(request?.eventFilters ?? []);
    const limit = normalizeLimit(request?.limit, this._cfg);
    const offset = decodeCursor(request?.cursor, 'sessions');

    const records = filterSessionResults(await this.listSessions(signal), sessionFilters);

    const hits = [];
    for (const record of records) {
      signal?.throwIfAborted();
      let loaded;
      try {
        loaded = await this._load(record.header.id);
      } catch {
        // 单个会话读不出来（损坏、格式过旧）不该让整次搜索失败：一个坏记录
        // 就返回空结果时，用户会以为搜索坏了，实际只是它一个。
        continue;
      }
      if (loaded.events.length === 0) continue;

      let documents;
      try {
        documents = buildSessionEventSearchDocuments(record.header.id, loaded.events);
      } catch {
        continue; // surface 折叠失败（投影损坏），同上
      }
      const scoped = filterSessionEventDocuments(documents, eventFilters);

      const matched = [];
      for (const doc of scoped) {
        if (firstMatchIndex(doc.text, terms) !== -1) matched.push(doc);
      }
      if (matched.length === 0) continue;

      hits.push({
        hit: {
          header: structuredClone(record.header),
          live: record.live === true,
          persisted: record.persisted === true,
          bestMatch: eventHit(record.header.id, matched[0], terms, this._cfg.snippetChars),
        },
        matchCount: matched.length,
        createdAt: record.header.createdAt ?? 0,
      });
    }

    // 命中多的会话排前面；同分按创建时间新→旧。基类的 listSessions 已按
    // createdAt 排好，重排是为了让「聊得最深的那个」浮上来。
    hits.sort((a, b) => b.matchCount - a.matchCount || b.createdAt - a.createdAt);

    const { items, hasMore } = slicePage(
      hits.map((h) => h.hit),
      offset,
      limit,
    );
    return {
      items,
      ...(hasMore ? { nextCursor: encodeCursor('sessions', offset + limit) } : {}),
    };
  }

  /// 单个会话内的搜索，返回事件级命中。
  async searchEvents(request, exec) {
    if (typeof request?.sessionId !== 'string') {
      throw new SessionQueryError('session-search session id must be text', 'SESSION_QUERY_INVALID_FILTER');
    }
    const sessionId = request.sessionId;
    const query = normalizeQuery(request?.query);
    const terms = termsOf(query);
    const filters = materializeSessionEventResultFilters(request?.filters ?? []);
    const limit = normalizeLimit(request?.limit, this._cfg);
    const offset = decodeCursor(request?.cursor, 'events');

    let loaded;
    try {
      loaded = await this._load(sessionId);
    } catch (error) {
      // 已经归一过的错误（缺会话、损坏）原样上抛，别包成 SUCCESS 形状。
      if (error instanceof SessionQueryError) throw error;
      throw new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND', {
        cause: error,
      });
    }

    const documents = buildSessionEventSearchDocuments(sessionId, loaded.events);
    const scoped = filterSessionEventDocuments(documents, filters);
    const matched = [];
    for (const doc of scoped) {
      if (firstMatchIndex(doc.text, terms) === -1) continue;
      matched.push(eventHit(sessionId, doc, terms, this._cfg.snippetChars));
    }

    const { items, hasMore } = slicePage(matched, offset, limit);
    return {
      session: structuredClone(loaded.header),
      items,
      ...(hasMore ? { nextCursor: encodeCursor('events', offset + limit) } : {}),
    };
  }
}
