/// 会话列表的数据源。
///
/// 两件事分开：**从哪拿**（这里）与**怎么显示**（`session_list.dart`）。之前
/// 列表是 `main.dart` 里一段 `_seed()` 硬编码的三个假会话 —— 界面看起来完整，
/// 但和运行时没有任何关系。这个文件把它换成 `session.list` 的真实结果，同时
/// 保留一个没有后端时的空实现，让桌面调试与 widget 测试仍然能跑。
library session_repository;

import 'dart:async';

import 'harness_client.dart';
import 'session_list.dart';

/// 空白会话（`blank == true`，从没发过消息）在列表里的名字。
///
/// 真值来源是上游侧栏的行标题函数
/// `impl/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js:2027`：
///
/// ```js
/// function displayTitle(node, t) {
///     return node.blank ? t("session.new") : node.title || t("session.untitled");
/// }
/// ```
///
/// 中文表在同文件 4763–4764 行：`"session.new": "新会话"`、`"session.untitled":
/// "未命名"`。这两个串是上游原话，别自造「未命名会话」之类的文案 —— 上一版就是
/// 那么写的，结果同一个会话在侧栏叫「未命名会话」、在对话页叫「新会话」。
const String kBlankSessionTitle = '新会话';

/// 有内容、但还没跑过标题投影的会话的名字（上游 `session.untitled` = "未命名"）。
const String kUntitledSessionTitle = '未命名';

/// 列表里一行的来源。`create()` 返回可打开的会话；返回 null 表示这个来源不
/// 支持新建（没有后端时）。
abstract class SessionSource {
  Future<List<SessionSummary>> list();
  Future<SessionSummary?> create();
}

/// 没有后端时的空实现。
///
/// 刻意返回空列表而不是样例数据：桌面/测试里看到「还没有会话」是真实情况，
/// 而三个假会话会让人以为列表坏了 —— 点进去是空的，还不知道为什么。
class EmptySessionSource implements SessionSource {
  const EmptySessionSource();

  @override
  Future<List<SessionSummary>> list() async => const [];

  @override
  Future<SessionSummary?> create() async => null;
}

/// 走 harness 桥的真实实现。
class HarnessSessionSource implements SessionSource {
  HarnessSessionSource(this._bridge);

  final HarnessBridge _bridge;

  @override
  Future<List<SessionSummary>> list() async {
    // `sessions` 是桥上的老命令（session.list 的包装），这里用它而不是 rpc：
    // 它已经把 `{ok, value}` 拆好了，出错路径也统一。
    //
    // 20 秒的依据（这不是拍脑袋的数字，改它之前先读完）：
    //
    //   * 后端 boot 期间这条命令会被 harness 挂住等 gateway attach，实测真机
    //     8–15 秒、慢设备到 25 秒。所以超时上限必须**大于**常见的 attach 时间，
    //     否则正常启动就会误报一次。
    //   * 慢设备那 25 秒落在这里会超时一次，代价是可见的：`_load` 会退避 2 秒
    //     重试，那一次落在 attach 之后，直接成功；重试期间 `_error` 保持 null，
    //     用户看不到这条失败。也就是说偶尔超时一次是无声的，而"永远不超时"的
    //     代价是首屏可能无限期转圈。
    //   * 曾经写的是 45 秒，理由是"多给慢设备留余量"。但 45 秒 × 4 次尝试 +
    //     14 秒退避 = 194 秒的沉默，这个数字本身就不能接受。而且真正"连不上"
    //     的情况已经由桥层快失败（`UnixHarnessBridge.bridgeDownCode`）在毫秒级
    //     报掉了，这里只剩"连上了却不回话"要兜 —— 20 秒足够证明对面卡死。
    final reply =
        await _bridge.request({'t': 'sessions'}, timeout: const Duration(seconds: 20));
    final raw = reply['v'];
    if (raw is! List) return const [];
    final out = <SessionSummary>[];
    for (final item in raw) {
      if (item is! Map) continue;
      final s = _toSummary(item);
      if (s != null) out.add(s);
    }
    return out;
  }

  @override
  Future<SessionSummary?> create() async {
    // `args` 的 key 是**方法形参名**，不是随便一层包装：typert 按源码签名
    // 校验，`session/create` 的签名是 `create(request: SessionCreateRequest)`，
    // 所以必须发 `{"args": {"request": {...}}}`。发空对象会得到
    //
    //   [gateway/arguments-invalid] session/create: args fields do not match
    //   the descriptor: missing "request"
    //
    // 这也是真机上「新建会话」报错的原因。注意 `session/list` 那边是
    // `list(_request)`，带下划线 —— 两个方法长得像，key 不一样。
    //
    // `SessionCreateRequest` 的四个字段（workspaceId / cwd / sessionId /
    // agentPreset）全部可选，空对象合法：实测后端会落到进程自己的工作目录，
    // 所以这里不需要猜一个 cwd 塞进去（写死 `/tmp` 会让会话的工作区变成一个
    // 用户没选过的目录）。
    final reply = await _bridge.request({
      't': 'rpc',
      'ns': 'session',
      'method': 'create',
      'args': <String, dynamic>{'request': <String, dynamic>{}},
    });
    final v = reply['v'];
    if (v is! Map) return null;
    final id = v['sessionId']?.toString();
    if (id == null || id.isEmpty) return null;
    return SessionSummary(
      id: id,
      // 「新会话」不是随手写的占位串：后端刚建的会话 `blank == true`，上游侧栏
      // 对 blank 行的显示值就是这个词（真值来源见 [_toSummary] 的注释）。以前
      // 这里写「新会话」、列表回落写「未命名会话」，于是新建后进对话、再返回
      // 列表，同一个会话换了个名字。
      title: kBlankSessionTitle,
      updatedAt: DateTime.now(),
    );
  }

  /// `session.list` 的一行 → 列表项。
  ///
  /// 字段名按上游 `summarizeCold`/`summaryFor` 的输出取：`sessionId` 与
  /// `updatedAt` 一定在；标题是投影，没跑过投影的会话就没有 —— 那时候按上游
  /// 的行标题规则兜底（blank 给「新会话」，其余给「未命名」），不是空字符串：
  /// 空标题会让列表里出现一行只有时间的空白条目。
  ///
  /// **投影挂在 `projections.values` 下面，不是 `projections` 下面。** 真机抓到的
  /// 一行（`impl/fixtures/gateway/session-list.json`）长这样：
  ///
  /// ```json
  /// {"sessionId":"session-1e06db63-…","updatedAt":1794996329660,"blank":true,
  ///  "projections":{"kind":"sequenced","asOfSeq":2,"values":{
  ///    "title":null,"agentPreset":"standard","workingDirectory":"/tmp/probe-ws",
  ///    "sessionListMetadata":{"blank":true,"lastPromptAt":null}}}}
  /// ```
  ///
  /// 这里之前只查 `projections.sessionListMetadata`，也就是少了一层 `values`：
  /// `meta` 永远是 null，`raw['title']` 在真数据里根本不存在，于是**每一行**都
  /// 落到兜底串 —— 列表能显示、时间是对的，只有标题全是同一个占位串。两处都改
  /// 成先查 `projections.values.…`，保留旧路径做回退：上游投影在不同版本里挪过
  /// 位置，写死单一路径会在换版本时静默退化成占位串。
  SessionSummary? _toSummary(Map raw) {
    final id = raw['sessionId']?.toString() ?? raw['id']?.toString();
    if (id == null || id.isEmpty) return null;

    final updated = _asDate(raw['updatedAt']) ?? DateTime.now();
    final values = _nested(raw, const ['projections', 'values']);
    final meta = _nested(raw, const ['projections', 'values', 'sessionListMetadata']) ??
        _nested(raw, const ['projections', 'sessionListMetadata']);

    // 候选顺序按**实测**定，不是按「看起来更权威」：
    //
    //   * `raw['title']` —— 真数据里没有这个键（`session/list` 的行不含顶层
    //     title），所以它是 null，留着只是为了兼容别的调用方给的摘要行；
    //   * `values['title']` —— 真正的标题投影。实测会话跑过标题之后这里是
    //     `"probe session"`（同一次 probe 的 `session-follow-snapshot.json`，
    //     `projections.values.title`）。标题 bug 就是漏了这一项；
    //   * `meta['title']` —— `sessionListMetadata` 实测只有 `{blank, lastPromptAt}`，
    //     没有 title；留着是因为旧路径的测试与未知版本可能带它。
    //
    // `raw['title']` 只有真值在时才会盖住后者，而它在真数据里恒为 null，所以放在
    // 最前面不会压掉投影里的标题。
    final title = _firstNonEmpty([
      raw['title'],
      values?['title'],
      meta?['title'],
      raw['name'],
    ]);

    // `blank` 顶层有（实测就是顶层字段），投影里也有一份；两边都认，免得某一
    // 版本只留了投影里的那份就认不出来。
    final isBlank = raw['blank'] == true || meta?['blank'] == true;

    return SessionSummary(
      id: id,
      // 兜底按上游 `displayTitle` 的规则分两种：blank 行给「新会话」，其余
      // 没标题的给「未命名」（见文件头的常量注释）。
      title: title ?? (isBlank ? kBlankSessionTitle : kUntitledSessionTitle),
      // preview 同一条路上来的，两个层级都查一遍。
      preview: _firstNonEmpty([meta?['preview'], values?['preview'], raw['preview']]) ?? '',
      updatedAt: updated,
      messageCount: _asInt(raw['messageCount']) ?? 0,
      running: raw['running'] == true,
      blank: isBlank,
    );
  }

  static Map? _nested(Map raw, List<String> path) {
    Object? cur = raw;
    for (final key in path) {
      if (cur is! Map) return null;
      cur = cur[key];
    }
    return cur is Map ? cur : null;
  }

  /// `updatedAt` 是毫秒时间戳（上游用 `number`）。容忍秒级时间戳：设备时钟或
  /// 旧日志里出现过 10 位数字，按毫秒解释会得到 1970 年。
  static DateTime? _asDate(Object? v) {
    if (v is int) {
      return DateTime.fromMillisecondsSinceEpoch(v < 100000000000 ? v * 1000 : v);
    }
    if (v is double) return _asDate(v.toInt());
    if (v is String) {
      final parsed = int.tryParse(v);
      if (parsed != null) return _asDate(parsed);
      return DateTime.tryParse(v);
    }
    return null;
  }

  static int? _asInt(Object? v) {
    if (v is int) return v;
    if (v is double) return v.toInt();
    if (v is String) return int.tryParse(v);
    return null;
  }

  static String? _firstNonEmpty(List<Object?> values) {
    for (final v in values) {
      if (v is String && v.trim().isNotEmpty) return v.trim();
    }
    return null;
  }
}
