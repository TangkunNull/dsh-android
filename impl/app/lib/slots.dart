/// Slot host: where plugin UI lands inside the native shell.
/// Input is the styled IR produced by the JS side (`tools/export.mjs`), so a
/// plugin's React component ends up as ordinary Flutter widgets here.
library slots;

import 'dart:convert';

import 'package:flutter/material.dart';
import 'ir.dart';
import 'renderer.dart';
import 'theme.dart';

class SlotBundle {
  final String plugin;
  final Map<String, IrNode> slots;

  const SlotBundle({required this.plugin, required this.slots});

  factory SlotBundle.fromJson(Map<String, dynamic> j) {
    final raw = (j['slots'] as Map?) ?? const {};
    final out = <String, IrNode>{};
    raw.forEach((k, v) {
      out[k.toString()] = IrNode.fromJson(Map<String, dynamic>.from(v as Map));
    });
    return SlotBundle(plugin: (j['plugin'] ?? '').toString(), slots: out);
  }

  factory SlotBundle.fromString(String s) =>
      SlotBundle.fromJson(jsonDecode(s) as Map<String, dynamic>);

  IrNode? operator [](String name) => slots[name];
  bool has(String name) => slots.containsKey(name);
}

/// Renders every entry registered for one slot name, in registration order.
/// Unknown slot names render nothing — the shell never crashes because a plugin
/// invented a seat (spec §3.4).
class SlotHost extends StatelessWidget {
  final SlotBundle bundle;
  final String name;
  final void Function(String eventId)? onEvent;
  final IrTheme theme;
  final MainAxisSize mainAxisSize;

  const SlotHost({
    super.key,
    required this.bundle,
    required this.name,
    this.onEvent,
    this.theme = IrTheme.light,
    this.mainAxisSize = MainAxisSize.min,
  });

  @override
  Widget build(BuildContext context) {
    final node = bundle[name];
    final children = <Widget>[];
    if (node != null) {
      children.add(IrRenderer(theme: theme, onEvent: onEvent).build(node));
    }
    // Also pick up keyed sub-slots (settings.section#<plugin-id>).
    bundle.slots.forEach((k, v) {
      if (k != name && k.startsWith('$name#')) {
        children.add(IrRenderer(theme: theme, onEvent: onEvent).build(v));
      }
    });
    if (children.isEmpty) return const SizedBox.shrink();
    return Row(
      key: Key('slot:$name'),
      mainAxisSize: mainAxisSize,
      children: children,
    );
  }
}
