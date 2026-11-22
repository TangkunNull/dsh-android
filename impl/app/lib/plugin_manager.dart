/// Plugin manager: the screen that makes "20 plugins work" inspectable.
///
/// A plugin that failed must be *visible* — its name, its error, and whether the
/// host quarantined it. Silent failure is the one outcome the gate forbids.
library plugin_manager;

import 'dart:convert';

import 'package:flutter/material.dart';

import 'dsh_tokens.dart';

enum PluginState { loaded, enabled, disabled, failed, quarantined }

PluginState _stateFrom(String? s) {
  switch (s) {
    case 'enabled':
      return PluginState.enabled;
    case 'disabled':
      return PluginState.disabled;
    case 'failed':
      return PluginState.failed;
    case 'quarantined':
      return PluginState.quarantined;
    default:
      return PluginState.loaded;
  }
}

class PluginInfo {
  final String id;
  final String version;
  final String description;
  final PluginState state;
  final String? error;
  final int slots;
  final List<String> caps;
  final String? source;
  final List<String> missingServices;

  const PluginInfo({
    required this.id,
    this.version = '0.0.0',
    this.description = '',
    this.state = PluginState.enabled,
    this.error,
    this.slots = 0,
    this.caps = const [],
    this.source,
    this.missingServices = const [],
  });

  bool get usable => state == PluginState.enabled || state == PluginState.loaded;
  bool get broken => state == PluginState.failed || state == PluginState.quarantined;

  factory PluginInfo.fromJson(Map<String, dynamic> j) => PluginInfo(
        id: (j['id'] ?? j['name'] ?? '?').toString(),
        version: (j['version'] ?? '0.0.0').toString(),
        description: (j['description'] ?? '').toString(),
        state: _stateFrom(j['state']?.toString()),
        error: j['error'] is Map ? (j['error']['message'] ?? '').toString() : j['error']?.toString(),
        slots: (j['slots'] is num) ? (j['slots'] as num).toInt() : 0,
        caps: ((j['caps'] as List?) ?? const []).map((e) => e.toString()).toList(),
        source: j['source']?.toString(),
        missingServices: ((j['missing'] as List?) ?? const []).map((e) => e.toString()).toList(),
      );

  /// `error` is sticky by default: toggling a broken plugin off must not erase
  /// the message that explains why it broke. Only `reset` clears it.
  PluginInfo copyWith({PluginState? state, String? error, bool clearError = false}) => PluginInfo(
        id: id,
        version: version,
        description: description,
        state: state ?? this.state,
        error: clearError ? null : (error ?? this.error),
        slots: slots,
        caps: caps,
        source: source,
        missingServices: missingServices,
      );
}

/// In-memory registry. The Node side writes `plugins.json`; on device this is
/// fed by the harness over the bridge.
class PluginRegistry extends ChangeNotifier {
  final List<PluginInfo> _items;

  PluginRegistry(this._items);

  factory PluginRegistry.fromJsonString(String s) {
    final raw = jsonDecode(s);
    final list = raw is List ? raw : (raw['plugins'] as List? ?? const []);
    return PluginRegistry(list.map((e) => PluginInfo.fromJson(Map<String, dynamic>.from(e as Map))).toList());
  }

  factory PluginRegistry.empty() => PluginRegistry(<PluginInfo>[]);

  List<PluginInfo> get all => List.unmodifiable(_items);
  List<PluginInfo> get broken => _items.where((p) => p.broken).toList();
  List<PluginInfo> get usable => _items.where((p) => p.usable).toList();
  int get enabledCount => usable.length;

  PluginInfo? byId(String id) {
    for (final p in _items) {
      if (p.id == id) return p;
    }
    return null;
  }

  void setState(String id, PluginState state) {
    final i = _items.indexWhere((p) => p.id == id);
    if (i == -1) return;
    // Quarantine is only cleared by an explicit reset, never by toggling.
    if (_items[i].state == PluginState.quarantined && state == PluginState.enabled) return;
    _items[i] = _items[i].copyWith(state: state);
    notifyListeners();
  }

  void enable(String id) => setState(id, PluginState.enabled);
  void disable(String id) => setState(id, PluginState.disabled);

  void reset(String id) {
    final i = _items.indexWhere((p) => p.id == id);
    if (i == -1) return;
    _items[i] = _items[i].copyWith(state: PluginState.loaded, clearError: true);
    notifyListeners();
  }

  void remove(String id) {
    _items.removeWhere((p) => p.id == id);
    notifyListeners();
  }
}

String stateLabel(PluginState s) {
  switch (s) {
    case PluginState.enabled:
      return '已启用';
    case PluginState.disabled:
      return '已停用';
    case PluginState.failed:
      return '加载失败';
    case PluginState.quarantined:
      return '已隔离';
    case PluginState.loaded:
      return '已加载';
  }
}

Color stateColor(PluginState s, ColorScheme c) {
  switch (s) {
    case PluginState.enabled:
    case PluginState.loaded:
      return const Color(0xFF22C55E);
    case PluginState.disabled:
      return c.outline;
    case PluginState.failed:
      return const Color(0xFFF59E0B);
    case PluginState.quarantined:
      return const Color(0xFFEC1313);
  }
}

/// 筛选口径。三个 chip 对应三种「我会拿它干什么」，不是三种状态值：
/// 全部（找东西）、已启用（看谁在跑）、有问题（该修谁）。
enum PluginFilter { all, usable, broken }

class PluginManagerScreen extends StatefulWidget {
  final PluginRegistry registry;
  const PluginManagerScreen({super.key, required this.registry});

  @override
  State<PluginManagerScreen> createState() => _PluginManagerScreenState();
}

class _PluginManagerScreenState extends State<PluginManagerScreen> {
  String _query = '';
  PluginFilter _filter = PluginFilter.all;

  List<PluginInfo> _visible(List<PluginInfo> all) {
    final q = _query.trim().toLowerCase();
    return all.where((p) {
      if (_filter == PluginFilter.usable && !p.usable) return false;
      if (_filter == PluginFilter.broken && !p.broken) return false;
      if (q.isEmpty) return true;
      // id + 描述 + 报错原文都能搜：查「为什么坏了」时手上只有错误文本。
      return p.id.toLowerCase().contains(q) ||
          p.description.toLowerCase().contains(q) ||
          (p.error ?? '').toLowerCase().contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.registry,
      builder: (context, _) {
        final t = DshTokens.of(context);
        final all = widget.registry.all;
        final items = _visible(all);
        return Scaffold(
          appBar: AppBar(
            title: const Text('插件', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            actions: [
              Center(
                child: Padding(
                  padding: const EdgeInsets.only(right: 16),
                  child: Text(
                    '${widget.registry.enabledCount}/${all.length}',
                    style: TextStyle(fontSize: 12, fontFamily: 'monospace', color: t.labelTertiary),
                  ),
                ),
              ),
            ],
          ),
          body: all.isEmpty
              ? const Center(child: Text('还没有安装插件'))
              : Column(
                  children: [
                    _toolbar(all),
                    Expanded(
                      child: items.isEmpty
                          ? Center(
                              child: Text(
                                _query.isEmpty ? '这个筛选下没有插件' : '没有匹配「$_query」的插件',
                                style: TextStyle(fontSize: 12.5, color: t.labelTertiary),
                              ),
                            )
                          : ListView.separated(
                              key: const Key('plugin-list'),
                              padding: const EdgeInsets.fromLTRB(12, 4, 12, 24),
                              itemCount: items.length,
                              separatorBuilder: (_, __) => const SizedBox(height: 8),
                              itemBuilder: (c, i) => _PluginTile(info: items[i], registry: widget.registry),
                            ),
                    ),
                  ],
                ),
        );
      },
    );
  }

  Widget _toolbar(List<PluginInfo> all) {
    final t = DshTokens.of(context);
    final broken = all.where((p) => p.broken).length;
    final counts = {
      PluginFilter.all: all.length,
      PluginFilter.usable: all.where((p) => p.usable).length,
      PluginFilter.broken: broken,
    };
    const labels = {
      PluginFilter.all: '全部',
      PluginFilter.usable: '已启用',
      PluginFilter.broken: '有问题',
    };
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
      child: Column(
        children: [
          TextField(
            key: const Key('plugin-search'),
            onChanged: (v) => setState(() => _query = v),
            style: const TextStyle(fontSize: 13),
            decoration: InputDecoration(
              isDense: true,
              hintText: '搜索插件 / 报错',
              hintStyle: const TextStyle(fontSize: 12.5),
              prefixIcon: const Icon(Icons.search, size: 18),
              filled: true,
              fillColor: t.bgLayer2,
              contentPadding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
              border: OutlineInputBorder(borderRadius: BorderRadius.circular(10), borderSide: BorderSide.none),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              for (final f in PluginFilter.values)
                Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: _FilterChip(
                    key: Key('plugin-filter-${f.name}'),
                    label: '${labels[f]} ${counts[f]}',
                    selected: _filter == f,
                    // 有问题的用错误色：这是唯一需要立刻处理的分类。
                    tone: f == PluginFilter.broken ? t.stateError : t.labelPrimary,
                    onTap: () => setState(() => _filter = f),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  final String label;
  final bool selected;
  final Color tone;
  final VoidCallback onTap;

  const _FilterChip({super.key, required this.label, required this.selected, required this.tone, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? tone.withOpacity(0.14) : Colors.transparent,
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: selected ? tone.withOpacity(0.5) : DshTokens.of(context).borderL3, width: DshTokens.hairline),
        ),
        child: Text(
          label,
          style: TextStyle(fontSize: 11.5, color: selected ? tone : DshTokens.of(context).labelSecondary),
        ),
      ),
    );
  }
}

class _PluginTile extends StatelessWidget {
  final PluginInfo info;
  final PluginRegistry registry;
  const _PluginTile({required this.info, required this.registry});

  @override
  Widget build(BuildContext context) {
    final t = DshTokens.of(context);
    final color = stateColor(info.state, Theme.of(context).colorScheme);
    return Container(
      key: Key('plugin-${info.id}'),
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: BoxDecoration(
        color: t.bgBase,
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: t.borderL2, width: DshTokens.hairline),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Container(
              width: 7,
              height: 7,
              decoration: BoxDecoration(color: color, shape: BoxShape.circle),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        info.id,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13.5, fontFamily: 'monospace', fontWeight: FontWeight.w500),
                      ),
                    ),
                    const SizedBox(width: 6),
                    Text(info.version, style: TextStyle(fontSize: 10.5, fontFamily: 'monospace', color: t.labelTertiary)),
                  ],
                ),
                if (info.description.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text(
                      info.description,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, height: 1.4, color: t.labelSecondary),
                    ),
                  ),
                if (info.error != null && info.error!.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: 6),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                    decoration: BoxDecoration(
                      color: t.stateError.withOpacity(0.07),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: t.stateError.withOpacity(0.2), width: DshTokens.hairline),
                    ),
                    child: Text(
                      info.error!,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 11, fontFamily: 'monospace', height: 1.45, color: t.stateError),
                    ),
                  ),
                if (info.caps.isNotEmpty || info.missingServices.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Wrap(
                      spacing: 6,
                      runSpacing: 4,
                      children: [
                        for (final cap in info.caps) _Chip(label: cap, tone: DshTokens.of(context).stateWarn),
                        for (final svc in info.missingServices) _Chip(label: '缺少 $svc', tone: t.labelTertiary),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          Column(
            children: [
              Text(stateLabel(info.state), style: TextStyle(fontSize: 10.5, color: color)),
              Switch(
                key: Key('switch-${info.id}'),
                value: info.usable,
                onChanged: (v) => v ? registry.enable(info.id) : registry.disable(info.id),
              ),
              if (info.broken)
                InkWell(
                  key: Key('plugin-retry-${info.id}'),
                  onTap: () => registry.reset(info.id),
                  borderRadius: BorderRadius.circular(6),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
                    child: Text('重新尝试', style: TextStyle(fontSize: 11.5, color: t.labelPrimary)),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  final String label;
  final Color tone;
  const _Chip({required this.label, required this.tone});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: tone.withOpacity(0.12),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(label, style: TextStyle(fontSize: 10.5, color: tone)),
    );
  }
}
