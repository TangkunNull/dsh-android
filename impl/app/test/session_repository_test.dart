// 会话列表的数据源测试。
//
// 这里断言的是**字段映射**，不是协议：`session.list` 的每一行长什么样由上游
// 决定，Dart 侧只做翻译。翻译出错的表现很隐蔽 —— 列表能显示，但时间全是 1970
// 或者标题全是「未命名会话」，用户不会报 bug，只会觉得这个 App 很粗糙。

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
  Future<Map<String, dynamic>> request(Map<String, dynamic> command) async {
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
      expect(list.single.title, '未命名会话', reason: '空标题会让列表出现一行空白条目');
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
      expect(bridge.sent.single['t'], 'rpc');
      expect(bridge.sent.single['ns'], 'session');
      expect(bridge.sent.single['method'], 'create');
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
