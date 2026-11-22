/// Platform capabilities (G-5), behind an interface so every screen can be tested
/// without a device, and so "does this phone support X" never becomes an
/// `if (SDK_INT >= N)` scattered across the UI (decision D7).
library platform_caps;

import 'dart:convert';
import 'dart:typed_data';

abstract class PlatformCaps {
  Future<void> copyText(String text);
  Future<String?> readClipboard();
  Future<void> share({required String text, String? subject});
  Future<void> openExternal(String url);
  Future<String?> pickFile({List<String> extensions = const []});
  Future<void> vibrate({int ms = 12});
  Future<void> notify(String title, String body);
  bool get canBlur;
  bool get hasForegroundServiceType;
  bool get canLoadSoFromPrivateDir;
}

/// Deterministic double for tests and for the desktop preview.
class FakePlatformCaps implements PlatformCaps {
  final List<String> calls = <String>[];
  String clipboard = '';
  Map<String, String> files = <String, String>{};

  @override
  Future<void> copyText(String text) async {
    clipboard = text;
    calls.add('copy:$text');
  }

  @override
  Future<String?> readClipboard() async => clipboard;

  @override
  Future<void> share({required String text, String? subject}) async => calls.add('share:${subject ?? ''}:$text');

  @override
  Future<void> openExternal(String url) async => calls.add('open:$url');

  @override
  Future<String?> pickFile({List<String> extensions = const []}) async {
    calls.add('pick:${extensions.join(",")}');
    return files.isEmpty ? null : files.keys.first;
  }

  @override
  Future<void> vibrate({int ms = 12}) async => calls.add('vibrate:$ms');

  @override
  Future<void> notify(String title, String body) async => calls.add('notify:$title');

  @override
  bool get canBlur => true;

  @override
  bool get hasForegroundServiceType => true;

  @override
  bool get canLoadSoFromPrivateDir => false;
}

/// Placeholder for the real Android implementation: JNI/MethodChannel wiring is
/// blocked on the SDK, and pretending otherwise would be worse than an explicit
/// throw at the one place that needs a device.
class UnimplementedPlatformCaps implements PlatformCaps {
  const UnimplementedPlatformCaps();

  Never _no(String what) =>
      throw UnsupportedError('$what requires the Android host (see G-5)');

  @override
  Future<void> copyText(String text) async => _no('clipboard');

  @override
  Future<String?> readClipboard() async => _no('clipboard');

  @override
  Future<void> share({required String text, String? subject}) async => _no('share');

  @override
  Future<void> openExternal(String url) async => _no('openExternal');

  @override
  Future<String?> pickFile({List<String> extensions = const []}) async => _no('SAF picker');

  @override
  Future<void> vibrate({int ms = 12}) async => _no('vibrator');

  @override
  Future<void> notify(String title, String body) async => _no('notification');

  @override
  bool get canBlur => true;

  @override
  bool get hasForegroundServiceType => true;

  @override
  bool get canLoadSoFromPrivateDir => false;
}

/// Capability probe used to decide whether a plugin's heavy feature can run.
class CapabilityReport {
  final bool canvas;
  final bool video;
  final bool iframe;
  final bool webgl;
  final List<String> reasons;

  const CapabilityReport({
    this.canvas = false,
    this.video = false,
    this.iframe = false,
    this.webgl = false,
    this.reasons = const [],
  });

  static CapabilityReport fromCaps(List<String> caps) {
    final reasons = <String>[];
    if (caps.contains('canvas')) reasons.add('canvas 需要 P3.5 绘制桥');
    if (caps.contains('video')) reasons.add('video 需要 P3.5 播放器映射');
    if (caps.contains('iframe')) reasons.add('iframe 仅支持同源 srcdoc');
    if (caps.contains('webgl')) reasons.add('WebGL 暂缓（D9）');
    return CapabilityReport(
      canvas: caps.contains('canvas'),
      video: caps.contains('video'),
      iframe: caps.contains('iframe'),
      webgl: caps.contains('webgl'),
      reasons: reasons,
    );
  }

  bool get fullySupported => reasons.isEmpty;
}

/// Tiny helper used by the terminal screen to size its grid from a font metric.
class GridMetrics {
  final double charWidth;
  final double lineHeight;
  const GridMetrics(this.charWidth, this.lineHeight);

  static GridMetrics fromFont(double fontSize, {double letterSpacing = 0}) =>
      GridMetrics(fontSize * 0.6 + letterSpacing, fontSize * 1.35);

  int colsFor(double width) => width <= 0 ? 80 : (width / charWidth).floor().clamp(20, 400);
  int rowsFor(double height) => height <= 0 ? 24 : (height / lineHeight).floor().clamp(4, 200);
}

/// Uint8List helper kept here so the terminal screen does not import dart:typed_data
/// in two places (and so the fake PTY in tests has one entry point).
///
/// `codeUnits` would truncate every UTF-16 unit to one byte, turning 中 (0x4E2D)
/// into 0x2D — non-ASCII output from the shell would arrive as garbage.
Uint8List utf8Bytes(String s) => Uint8List.fromList(utf8.encode(s));
