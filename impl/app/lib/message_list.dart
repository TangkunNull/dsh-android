/// Message list: virtualised, and anchored the way a chat transcript must be.
///
/// Two things break chat UIs on phones: building every bubble (a 400-message
/// session rebuilds on every token) and stealing the scroll position while the
/// user is reading history. This file solves both with one rule — "stick to the
/// bottom only if the user was already there".
library message_list;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'session.dart';

/// Pure decision logic, kept out of the widget so it can be tested without a
/// rendering pipeline (see test/message_list_test.dart).
class ScrollAnchor {
  /// Distance from the bottom, in logical pixels, under which we consider the
  /// user "at the bottom". One line of text is ~20px; 80 leaves room for a
  /// finger that has not quite reached the end.
  static const double threshold = 80;

  double _offset = 0;
  double _maxScroll = 0;
  bool _stick = true;

  bool get sticky => _stick;

  /// Both call sites hand us `maxScrollExtent`, which Flutter already defines
  /// as `contentExtent - viewport`. Subtracting the viewport a second time here
  /// would leave the list a full screen short of the bottom.
  double get distanceToBottom => math.max(0, _maxScroll - _offset);

  /// Record a scroll event. Scrolling up detaches; returning to the bottom
  /// re-attaches. This is what stops a streaming reply from yanking the view
  /// while the user reads an earlier message.
  void onScroll({required double offset, required double maxScrollExtent}) {
    _offset = offset;
    _maxScroll = maxScrollExtent;
    _stick = distanceToBottom <= threshold;
  }

  /// Content grew (a token arrived, a tool card expanded).
  /// Returns the offset to jump to, or null to leave the view alone.
  double? onContentGrow({required double maxScrollExtent}) {
    _maxScroll = maxScrollExtent;
    if (!_stick) return null;
    return math.max(0, maxScrollExtent);
  }

  void attach() => _stick = true;
}

/// Physical constants for the list. Kept here so the golden tests and the app
/// agree on the same numbers.
class MessageListMetrics {
  static const double estimatedItemHeight = 96;
  static const double cacheExtent = 600;
}

class MessageListView extends StatefulWidget {
  final List<Message> messages;
  final ScrollController controller;
  final Widget Function(BuildContext, Message, int) itemBuilder;
  final Widget? header;
  final EdgeInsets padding;

  const MessageListView({
    super.key,
    required this.messages,
    required this.controller,
    required this.itemBuilder,
    this.header,
    this.padding = const EdgeInsets.symmetric(horizontal: 16),
  });

  @override
  State<MessageListView> createState() => _MessageListViewState();
}

class _MessageListViewState extends State<MessageListView> {
  final _anchor = ScrollAnchor();
  int _lastCount = 0;
  int _lastLength = 0;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onScroll);
    _lastCount = widget.messages.length;
    _lastLength = _contentSignature();
    // Opening a session must land on the newest message, and the anchor must be
    // seeded from the real geometry: "sticky until proven otherwise" would make
    // an already-scrolled-to-top list (offset 0, so jumpTo(0) emits no event)
    // look attached forever.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !widget.controller.hasClients) return;
      final p = widget.controller.position;
      if (p.maxScrollExtent > 0 && (p.pixels - p.maxScrollExtent).abs() > 0.5) {
        widget.controller.jumpTo(p.maxScrollExtent);
      }
      _anchor.onScroll(offset: widget.controller.position.pixels, maxScrollExtent: widget.controller.position.maxScrollExtent);
    });
  }

  @override
  void didUpdateWidget(covariant MessageListView old) {
    super.didUpdateWidget(old);
    final grew = _contentSignature() != _lastLength;
    _lastLength = _contentSignature();
    if (grew) _afterGrow();
    if (widget.messages.length != _lastCount) {
      _lastCount = widget.messages.length;
      _afterGrow();
    }
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onScroll);
    super.dispose();
  }

  int _contentSignature() {
    if (widget.messages.isEmpty) return 0;
    final last = widget.messages.last;
    var n = last.text.length + last.thinking.length;
    for (final t in last.tools) {
      n += (t.result?.length ?? 0) + t.name.length;
    }
    return n;
  }

  void _onScroll() {
    if (!widget.controller.hasClients) return;
    final p = widget.controller.position;
    _anchor.onScroll(offset: p.pixels, maxScrollExtent: p.maxScrollExtent);
  }

  void _afterGrow() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !widget.controller.hasClients) return;
      final p = widget.controller.position;
      final target = _anchor.onContentGrow(maxScrollExtent: p.maxScrollExtent);
      if (target != null && (target - p.pixels).abs() > 0.5) {
        widget.controller.jumpTo(target);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    // A reversed list is the cheap way to keep the newest item pinned, but it
    // also reverses index order and breaks semantics for screen readers. A
    // normal list with an explicit anchor is worth the extra bookkeeping.
    return ListView.builder(
      controller: widget.controller,
      padding: widget.padding.copyWith(bottom: 12),
      cacheExtent: MessageListMetrics.cacheExtent,
      itemCount: widget.messages.length + (widget.header == null ? 0 : 1),
      itemBuilder: (context, index) {
        if (widget.header != null) {
          if (index == 0) return widget.header!;
          return widget.itemBuilder(context, widget.messages[index - 1], index - 1);
        }
        return widget.itemBuilder(context, widget.messages[index], index);
      },
    );
  }
}
