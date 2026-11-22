/// Contract tests for the two-phase boot call.
///
/// `startHarness` must return immediately and `awaitReady` must be the single
/// blocking wait — the old code waited on `waitEndpoint` for 8 s, which a cold
/// start could never satisfy. The mock channel also pins the status strings the
/// UI shows while the runtime is still unpacking.

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/host_boot.dart';

/// Runs [body] with the platform pinned to Android.
///
/// Reset in `finally`, not in `tearDown`: the binding asserts that the debug
/// variable is unset as soon as the test body returns, before tearDown runs.
Future<void> asAndroid(Future<void> Function() body) async {
  debugDefaultTargetPlatformOverride = TargetPlatform.android;
  try {
    await body();
  } finally {
    debugDefaultTargetPlatformOverride = null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final messenger = TestDefaultBinaryMessengerBinding.instance!.defaultBinaryMessenger;
  late List<String> calls;

  /// Answers every channel call from [responses]; records the method order.
  void mockChannel(Object? Function(String method) responses) {
    messenger.setMockMethodCallHandler(HostBootstrap.channel, (call) async {
      calls.add(call.method);
      return responses(call.method);
    });
  }

  setUp(() {
    calls = <String>[];
    HostBootstrap.status.value = 'not started';
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(HostBootstrap.channel, null);
  });

  testWidgets('start is non-blocking and awaitReady is the only wait', (tester) async {
    mockChannel((method) {
      switch (method) {
        case 'paths':
          return <String, Object?>{'filesDir': '/data/user/0/ai.dsh.app/files'};
        case 'startHarness':
          return true;
        case 'awaitReady':
          return <String, Object?>{
            'status': <String, Object?>{
              'state': 'running',
              'done': -1,
              'total': -1,
              'message': '',
              'updatedAt': 1732000000000,
            },
            'endpoint': <String, Object?>{
              'socket': '/data/user/0/ai.dsh.app/files/harness.sock',
              'token': 'tk-1',
              'pid': 4242,
              'proto': 1,
            },
          };
        default:
          return null;
      }
    });

    await asAndroid(() async {
      final endpoint = await HostBootstrap.ensureRunning();

      expect(endpoint, isNotNull);
      expect(endpoint!.socketPath, '/data/user/0/ai.dsh.app/files/harness.sock');
      expect(endpoint.token, 'tk-1');
      expect(endpoint.pid, 4242);
      expect(HostBootstrap.status.value, '已就绪');
      // No Dart-side endpoint polling: exactly one start and one wait.
      expect(calls, <String>['paths', 'startHarness', 'awaitReady']);
    });
  });

  testWidgets('a failed runtime returns null and keeps the reason', (tester) async {
    mockChannel((method) {
      switch (method) {
        case 'paths':
          return <String, Object?>{'filesDir': '/f'};
        case 'startHarness':
          return true;
        case 'awaitReady':
          return <String, Object?>{
            'status': <String, Object?>{
              'state': 'failed',
              'done': -1,
              'total': -1,
              'message': 'node runtime did not start',
              'updatedAt': 1732000000000,
            },
            'endpoint': null,
          };
        default:
          return null;
      }
    });

    await asAndroid(() async {
      final endpoint = await HostBootstrap.ensureRunning();

      expect(endpoint, isNull);
      expect(HostBootstrap.status.value, '启动失败：node runtime did not start');
    });
  });

  testWidgets('a timed-out wait keeps the last step visible', (tester) async {
    mockChannel((method) {
      switch (method) {
        case 'paths':
          return <String, Object?>{'filesDir': '/f'};
        case 'startHarness':
          return true;
        case 'awaitReady':
          return <String, Object?>{
            'status': <String, Object?>{
              'state': 'unpacking',
              'done': 3500,
              'total': 16452,
              'message': '',
              'updatedAt': 1732000000000,
            },
            'endpoint': null,
          };
        default:
          return null;
      }
    });

    await asAndroid(() async {
      final endpoint = await HostBootstrap.ensureRunning(timeout: const Duration(milliseconds: 20));

      expect(endpoint, isNull);
      expect(HostBootstrap.status.value, '启动超时：正在解压运行时 (3500/16452)');
    });
  });
}
