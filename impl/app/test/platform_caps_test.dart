/// Platform capabilities and the capability report. Everything here exists so
/// the rest of the UI never asks "which Android version is this" — it asks the
/// interface, and tests answer with a fake.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/platform_caps.dart';

void main() {
  group('FakePlatformCaps', () {
    test('records calls in order and round-trips the clipboard', () async {
      final caps = FakePlatformCaps();
      await caps.copyText('你好');
      expect(caps.clipboard, '你好');
      expect(await caps.readClipboard(), '你好');
      expect(caps.calls, ['copy:你好']);
    });

    test('share / open / vibrate / notify are all observable', () async {
      final caps = FakePlatformCaps();
      await caps.share(text: 'body', subject: 'subj');
      await caps.openExternal('https://example.com');
      await caps.vibrate(ms: 30);
      await caps.notify('t', 'b');
      expect(caps.calls, ['share:subj:body', 'open:https://example.com', 'vibrate:30', 'notify:t']);
    });

    test('pickFile returns null when nothing is staged', () async {
      final caps = FakePlatformCaps();
      expect(await caps.pickFile(extensions: ['png', 'jpg']), isNull);
      expect(caps.calls, ['pick:png,jpg']);

      caps.files['/tmp/a.png'] = 'x';
      expect(await caps.pickFile(), '/tmp/a.png');
    });

    test('reports capability flags', () {
      expect(FakePlatformCaps().canLoadSoFromPrivateDir, isFalse);
      expect(FakePlatformCaps().canBlur, isTrue);
    });
  });

  group('UnimplementedPlatformCaps', () {
    test('every call throws an error that names the missing bridge', () async {
      const caps = UnimplementedPlatformCaps();
      await expectLater(caps.copyText('x'), throwsA(isA<UnsupportedError>()));
      await expectLater(caps.readClipboard(), throwsA(isA<UnsupportedError>()));
      await expectLater(caps.share(text: 'x'), throwsA(isA<UnsupportedError>()));
      await expectLater(caps.openExternal('https://a'), throwsA(isA<UnsupportedError>()));
      await expectLater(caps.pickFile(), throwsA(isA<UnsupportedError>()));
      await expectLater(caps.vibrate(), throwsA(isA<UnsupportedError>()));
      await expectLater(caps.notify('t', 'b'), throwsA(isA<UnsupportedError>()));
    });

    test('the message points at the gate, not at a stack trace', () async {
      try {
        await const UnimplementedPlatformCaps().copyText('x');
        fail('should have thrown');
      } on UnsupportedError catch (e) {
        expect(e.message, contains('G-5'));
      }
    });
  });

  group('CapabilityReport', () {
    test('no unsupported caps means fully supported', () {
      final r = CapabilityReport.fromCaps(const ['clipboard', 'notification']);
      expect(r.fullySupported, isTrue);
      expect(r.reasons, isEmpty);
      expect(r.canvas, isFalse);
    });

    test('each unsupported capability contributes one reason', () {
      final r = CapabilityReport.fromCaps(const ['canvas', 'video', 'iframe', 'webgl']);
      expect(r.fullySupported, isFalse);
      expect(r.reasons.length, 4);
      expect(r.canvas && r.video && r.iframe && r.webgl, isTrue);
      expect(r.reasons.join(' '), contains('canvas'));
    });

    test('duplicates do not double-count', () {
      final r = CapabilityReport.fromCaps(const ['canvas', 'canvas']);
      expect(r.reasons.length, 1);
    });
  });

  group('GridMetrics', () {
    test('derives cell size from the font size', () {
      final m = GridMetrics.fromFont(13);
      expect(m.charWidth, closeTo(7.8, 1e-9));
      expect(m.lineHeight, closeTo(17.55, 1e-9));
    });

    test('letter spacing widens the cell', () {
      final m = GridMetrics.fromFont(13, letterSpacing: 1);
      expect(m.charWidth, closeTo(8.8, 1e-9));
    });

    test('cols and rows are clamped to a sane range', () {
      final m = GridMetrics.fromFont(14);
      expect(m.colsFor(0), 80);
      expect(m.rowsFor(0), 24);
      expect(m.colsFor(1), 20); // too narrow: clamped, not 0
      expect(m.rowsFor(1), 4);
      expect(m.colsFor(10000), 400);
      expect(m.rowsFor(10000), 200);
    });

    test('a phone-sized viewport gives a usable shell grid', () {
      final m = GridMetrics.fromFont(13);
      expect(m.colsFor(390), greaterThan(40));
      expect(m.rowsFor(600), greaterThan(25));
    });
  });

  group('utf8Bytes', () {
    test('ASCII is one byte per char', () {
      expect(utf8Bytes('ls -la'), utf8.encode('ls -la'));
    });

    test('CJK is encoded as real UTF-8, not truncated UTF-16 units', () {
      final bytes = utf8Bytes('中');
      expect(bytes, [0xE4, 0xB8, 0xAD]);
      expect(utf8.decode(bytes), '中');
    });

    test('an emoji (surrogate pair) survives the round trip', () {
      expect(utf8.decode(utf8Bytes('ok 🎉')), 'ok 🎉');
    });
  });
}
