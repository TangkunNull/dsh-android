// SPDX-License-Identifier: AGPL-3.0-only
/// 设置页里**真的能改**的那几个值，存在哪、怎么读。
///
/// 为什么自己写一层而不是 `shared_preferences`：这个壳层已经有一条通向原生侧的
/// 通道（`ai.dsh/host` 的 `paths` 给出 `filesDir`），而 `llm.json` 也落在同一个
/// 目录。多引一个插件依赖只为存 6 个字符串，不划算，而且那会把「偏好文件在哪」
/// 变成两套答案。
///
/// 退化路径是**明确**的：通道不存在（桌面 / `flutter test`）或文件读不出来时，
/// 值只活在内存里，[persistent] 返回 false —— 设置页据此显示「仅内存」，而不是
/// 假装已经存下来了。
library settings_prefs;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';

/// 偏好键。写进 `settings.json` 的键名就是这些字符串，别随手改 ——
/// 改动等于把用户已经设好的值丢掉一次。
class SettingsKeys {
  const SettingsKeys._();

  /// 偏好文件名（落在 `filesDir` 下，与 `llm.json` 同级）。
  static const String fileName = 'settings.json';

  /// 外观：`light` / `dark` / `system`。
  static const String appearance = 'settings.appearance';

  /// 字号大小：`small` / `default` / `large`。
  static const String fontScale = 'settings.fontScale';

  /// 工作步骤展示：`collapsed` / `expanded`。
  static const String transcriptView = 'settings.transcriptView';

  /// 显示代码工作视图：`true` / `false`。
  static const String codeWorkView = 'settings.codeWorkView';

  /// 网页链接默认打开方式：`inapp` / `browser`。
  static const String linkOpening = 'settings.linkOpening';

  /// 繁忙时的发送行为：`queue` / `interrupt`。
  static const String composerEnter = 'settings.composerEnter';

  /// 当前选中的 Agent 预设（`standard` / `ptc` / `minimal` / `creative`）。
  static const String agentPreset = 'settings.agentPreset';

  /// 「设为新任务默认」记下的预设 id。
  static const String agentPresetDefault = 'settings.agentPresetDefault';
}

/// 键值 + JSON 文件的一层薄存储。
///
/// 读取是**一次性**的：[load] 只在打开设置页时跑一遍，之后全走内存
/// （[stringOf] / [boolOf] 都是同步的，build 里可以直接读）。
/// 写入是即时的：`put` 先改内存再异步落盘，调用方不需要 await。
class SettingsStore {
  /// [persist] 为 false 时连通道都不问，纯内存 —— 测试用。
  SettingsStore({this.persist = true});

  /// 是否允许落盘。false = 纯内存（测试 / 明确不要持久化的场景）。
  final bool persist;

  /// 与 `host_boot.dart` 同一个通道；这里只用 `paths`，不碰运行时。
  static const MethodChannel channel = MethodChannel('ai.dsh/host');

  final Map<String, String> _values = <String, String>{};

  String? _dir;

  bool _loaded = false;

  /// [load] 是否已经跑过（跑过之后不会再读文件）。
  bool get loaded => _loaded;

  /// 是否真的落盘了：false 表示通道不存在或目录取不到，值只在内存里。
  bool get persistent => _dir != null;

  /// 当前全部键值（只读快照，「查看配置」用它）。
  Map<String, String> get snapshot =>
      Map<String, String>.unmodifiable(Map<String, String>.from(_values));

  /// 读一次 `filesDir/settings.json`。文件不存在 / 内容坏了都当「没有偏好」，
  /// 设置页必须能打开，不能因为一个坏 JSON 白屏。
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    if (!persist) return;
    try {
      final paths = await channel.invokeMapMethod<String, dynamic>('paths');
      final dir = paths == null ? null : paths['filesDir'];
      if (dir is! String || dir.isEmpty) return;
      _dir = dir;
      final file = File('$_dir/${SettingsKeys.fileName}');
      if (!file.existsSync()) return;
      final decoded = json.decode(await file.readAsString());
      if (decoded is Map) {
        decoded.forEach((key, value) {
          if (key is String && value != null) _values[key] = value.toString();
        });
      }
    } on MissingPluginException {
      // 桌面 / 测试没有这条通道：内存存储，不假装持久化。
    } catch (_) {
      // 读不出来（权限、半截文件、非法 JSON）就当没有偏好。
    }
  }

  /// 读一个值；没有就返回 null。
  String? value(String key) => _values[key];

  /// 读一个字符串值；空串与缺失都退回 [fallback]。
  String stringOf(String key, String fallback) {
    final v = _values[key];
    return v == null || v.isEmpty ? fallback : v;
  }

  /// 读一个布尔值；接受 `true` / `1`。
  bool boolOf(String key, {bool fallback = false}) {
    final v = _values[key];
    if (v == null) return fallback;
    return v == 'true' || v == '1';
  }

  /// 写一个值（同步改内存，异步落盘）。值没变就不写文件。
  void put(String key, String value) {
    if (_values[key] == value) return;
    _values[key] = value;
    unawaited(_flush());
  }

  /// 写一个布尔值。
  void putBool(String key, bool value) => put(key, value ? 'true' : 'false');

  /// 把整份键值写回文件。落盘失败不影响内存里的值（下次打开还是默认值，
  /// 但至少这一轮用户看到的是自己刚选的）。
  Future<void> _flush() async {
    final dir = _dir;
    if (dir == null) return;
    try {
      await File('$dir/${SettingsKeys.fileName}')
          .writeAsString(json.encode(_values), flush: true);
    } catch (_) {
      // 忽略：写不进去不该让点击变成异常。
    }
  }
}
