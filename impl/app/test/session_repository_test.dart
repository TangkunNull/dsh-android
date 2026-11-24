// 会话列表的数据源测试。
//
// 这里断言的是**字段映射**，不是协议：`session.list` 的每一行长什么样由上游
// 决定，Dart 侧只做翻译。翻译出错的表现很隐蔽 —— 列表能显示，但时间全是 1970
// 或者标题全是同一个占位串，用户不会报 bug，只会觉得这个 App 很粗糙。

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/harness_client.dart';
import 'package:dsh_native/session_repository.dart';

class FakeBridge implements HarnessBridge {
  FakeBridge(this.reply);

  /// 依次吐出这些回复，用完之后重复最后一个。
  final List<Map<String, dynamic>> reply;
  final List<Map<String, dynamic>> sent = [];
  int _i = 0;

  @override
  Stream<Map<String, dynamic>> get events => const Stream.empty();

  @override
  void send(Map<String, dynamic> command) => sent.add(command);

  @override
  Future<Map<String, dynamic>> request(
    Map<String, dynamic> command, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    sent.add(command);
    final r = reply[_i.clamp(0, reply.length - 1)];
    if (_i < reply.length - 1) _i++;
    return r;
  }

  @override
  void dispose() {}
}

void main() {
  group('HarnessSessionSource', () {
    test('maps sessionId / updatedAt / title from the list reply', () async {
      final bridge = FakeBridge([
        {
          't': 'sessions',
          'id': 1,
          'v': [
            {
              'sessionId': 'sess-a',
              'updatedAt': 1731000000000,
              'running': true,
              'title': '修 ripgrep',
              'messageCount': 12,
            },
            {
              'sessionId': 'sess-b',
              'updatedAt': 1731000500000,
              'running': false,
              'projections': {
                'sessionListMetadata': {'title': '终端 ANSI'},
              },
            },
          ],
        },
      ]);

      final list = await HarnessSessionSource(bridge).list();
      expect(list.length, 2);
      expect(list[0].id, 'sess-a');
      expect(list[0].title, '修 ripgrep');
      expect(list[0].running, true);
      expect(list[0].messageCount, 12);
      expect(list[0].updatedAt.millisecondsSinceEpoch, 1731000000000);

      expect(list[1].title, '终端 ANSI', reason: '标题在 projections 里时也要能取到');
      expect(list[1].running, false);
    });

    test('a row without a title is named, not blank', () async {
      final bridge = FakeBridge([
        {
          't': 'sessions',
          'v': [
            {'sessionId': 'x', 'updatedAt': 1731000000000},
          ],
        },
      ]);
      final list = await HarnessSessionSource(bridge).list();
      // 不是 blank（发过消息），只是标题投影还没跑：上游侧栏给 `session.untitled`
      // 的中文值「未命名」（`dsh-client-ui-workspace/lib/client.js:4764`）。
      expect(list.single.title, kUntitledSessionTitle, reason: '空标题会让列表出现一行空白条目');
    });

    test('a blank row is called what upstream calls it: 新会话', () async {
      final bridge = FakeBridge([
        {
          't': 'sessions',
          'v': [
            {'sessionId': 'b', 'updatedAt': 1731000000000, 'blank': true},
          ],
        },
      ]);
      final list = await HarnessSessionSource(bridge).list();
      // 上游 `displayTitle`: `node.blank ? t("session.new") : …`，中文值是「新会话」；
      // 而 `create()` 新建出来的会话也是这个词。两边必须一致 —— 同一个会话在
      // 列表叫一个名、在对话页叫另一个名，是上一版的真实 bug。
      expect(list.single.title, kBlankSessionTitle);
      expect(list.single.blank, isTrue);
    });

    // ── 真机数据：投影在 projections.values 下面 ─────────────────────────────
    //
    // 下面这一行的形状逐字来自真机 probe 抓到的 `session/list`（存档在
    // `impl/fixtures/gateway/session-list.json`，会话 session-1e06db63-…）。
    // 抓取那一刻会话还是空的，所以 `values.title` 是 null；把同一次 probe 里第
    // 18 条 `session/title` 事件写进去的结果（`"probe session"`，见
    // `session-follow-snapshot.json` 的 `projections.values.title`）填回 title，
    // 就得到「标题投影跑过一次之后」的同一行 —— 正是标题 bug 踩到的形状。
    //
    // 之前 `_toSummary` 查的是 `projections.sessionListMetadata`（少了一层
    // `values`），于是拿不到标题，列表每一行都是同一个兜底串。
    Map<String, dynamic> realRow({Object? title = 'probe session', bool blank = false}) => {
          'sessionId': 'session-1e06db63-7460-42ce-bac4-ac9b6f9c23b6',
          'updatedAt': 1794996609928,
          'agentAvailable': true,
          'formatStatus': 'current',
          'running': false,
          'blank': blank,
          'cwd': '/tmp/probe-ws',
          'projections': {
            'kind': 'sequenced',
            'asOfSeq': 18,
            'values': {
              'userQuestions': {'active': <Object?>[], 'settled': <Object?>[]},
              'tokenUsage': {
                'uncachedInputTokens': 0,
                'outputTokens': 0,
                'cacheReadTokens': 0,
                'cacheWriteTokens': 0,
              },
              'title': title,
              'agentPreset': 'standard',
              'goal': null,
              'modelSelection': {
                'lastUsed': {'provider': 'deepseek-official', 'model': 'deepseek-flash'},
                'next': {'provider': 'deepseek-official', 'model': 'deepseek-flash'},
              },
              'workingDirectory': '/tmp/probe-ws',
              'inbox': {'next-turn': <Object?>[], 'next-step': <Object?>[]},
              'permissions': {'currentValue': 'workspace-write'},
              'subagentCatalog': <Object?>[],
              'subagentTiming': {'settledMs': 0},
              'subagent': null,
              'plan': {'active': false, 'pending': false},
              'sessionListMetadata': {
                'blank': blank,
                'lastPromptAt': blank ? null : 1794996609928,
              },
            },
          },
        };

    test('reads the title from projections.values, not from the placeholder', () async {
      final bridge = FakeBridge([
        {'t': 'sessions', 'v': [realRow()]},
      ]);
      final list = await HarnessSessionSource(bridge).list();

      expect(list.single.id, 'session-1e06db63-7460-42ce-bac4-ac9b6f9c23b6');
      expect(list.single.title, 'probe session',
          reason: '标题在 projections.values.title 里；查 projections.sessionListMetadata 会永远取不到');
      expect(list.single.title, isNot(kBlankSessionTitle));
      expect(list.single.title, isNot(kUntitledSessionTitle));
      expect(list.single.blank, false);
      expect(list.single.updatedAt.millisecondsSinceEpoch, 1794996609928);
    });

    test('the real blank row is titled 新会话 (title projection is null)', () async {
      // 同一次抓取里那一行的原样：`values.title: null` + `sessionListMetadata.blank: true`。
      // 这种会话还没有标题，但它是 blank —— 上游侧栏显示的是「新会话」，
      // 不是「未命名」（`session.untitled` 只给有内容但没标题的会话）。
      final bridge = FakeBridge([
        {'t': 'sessions', 'v': [realRow(title: null, blank: true)]},
      ]);
      final list = await HarnessSessionSource(bridge).list();
      expect(list.single.title, kBlankSessionTitle);
      expect(list.single.blank, true);
    });

    test('values wins over the legacy projections.sessionListMetadata path', () async {
      final bridge = FakeBridge([
        {
          't': 'sessions',
          'v': [
            {
              'sessionId': 'both',
              'updatedAt': 1731000000000,
              'projections': {
                'sessionListMetadata': {'title': '旧路径的标题'},
                'values': {
                  'title': '投影里的标题',
                  'sessionListMetadata': {'title': '新路径的另一种标题'},
                },
              },
            },
          ],
        },
      ]);
      final list = await HarnessSessionSource(bridge).list();
      expect(list.single.title, '投影里的标题',
          reason: 'values.title 是标题投影本身，优先于任何摘要式副本');
    });

    test('preview is read from projections.values as well', () async {
      final bridge = FakeBridge([
        {
          't': 'sessions',
          'v': [
            {
              'sessionId': 'p',
              'updatedAt': 1731000000000,
              'projections': {
                'values': {
                  'title': '有预览的会话',
                  'sessionListMetadata': {'preview': '把 CSS 转成 Widget IR'},
                },
              },
            },
          ],
        },
      ]);
      final list = await HarnessSessionSource(bridge).list();
      expect(list.single.preview, '把 CSS 转成 Widget IR');
    });

    test('a 10-digit timestamp is seconds, not 1970', () async {
      final bridge = FakeBridge([
        {
          't': 'sessions',
          'v': [
            {'sessionId': 'x', 'updatedAt': 1731000000},
          ],
        },
      ]);
      final list = await HarnessSessionSource(bridge).list();
      expect(list.single.updatedAt.year, greaterThan(2020));
    });

    test('rows without an id are dropped, not rendered empty', () async {
      final bridge = FakeBridge([
        {
          't': 'sessions',
          'v': [
            {'updatedAt': 1731000000000},
            {'sessionId': '', 'updatedAt': 1731000000000},
            {'sessionId': 'ok', 'updatedAt': 1731000000000},
          ],
        },
      ]);
      final list = await HarnessSessionSource(bridge).list();
      expect(list.length, 1);
      expect(list.single.id, 'ok');
    });

    test('create() goes through the rpc passthrough and returns the id', () async {
      final bridge = FakeBridge([
        {'t': 'rpc', 'ns': 'session', 'method': 'create', 'v': {'sessionId': 'new-1'}},
      ]);
      final s = await HarnessSessionSource(bridge).create();
      expect(s?.id, 'new-1');
      // 新建出来的是 blank 会话，名字必须和列表对 blank 行的兜底一致，否则
      // 进对话再返回就换了名字（QA F-2）。
      expect(s?.title, kBlankSessionTitle);
      expect(bridge.sent.single['t'], 'rpc');
      expect(bridge.sent.single['ns'], 'session');
      expect(bridge.sent.single['method'], 'create');
    });

    test('create() wraps the payload under the parameter name `request`', () async {
      // typert 按源码形参名校验 args：`create(request: SessionCreateRequest)`。
      // 发 `args: {}` 会被拒成
      //   [gateway/arguments-invalid] session/create: args fields do not match
      //   the descriptor: missing "request"
      // —— 真机上「新建会话」报的就是这句。
      // 注意 `session/list` 那边是 `list(_request)`（带下划线），两个方法长得
      // 像但 key 不同，别照抄。
      final bridge = FakeBridge([
        {'t': 'rpc', 'v': {'sessionId': 'new-1'}},
      ]);
      await HarnessSessionSource(bridge).create();

      final args = bridge.sent.single['args'];
      expect(args, isA<Map<String, dynamic>>());
      final request = (args as Map<String, dynamic>)['request'];
      expect(request, isA<Map<String, dynamic>>(), reason: 'args 必须按形参名 request 包裹');
      expect(request as Map<String, dynamic>, isEmpty,
          reason: 'SessionCreateRequest 四个字段全可选，空对象就够了（cwd 由后端兜底）');
    });

    test('create() returns null when the reply has no id', () async {
      final bridge = FakeBridge([
        {'t': 'rpc', 'v': <String, dynamic>{}},
      ]);
      expect(await HarnessSessionSource(bridge).create(), isNull);
    });
  });

  group('EmptySessionSource', () {
    test('is empty rather than full of fake rows', () async {
      const src = EmptySessionSource();
      expect(await src.list(), isEmpty);
      expect(await src.create(), isNull);
    });
  });
}
