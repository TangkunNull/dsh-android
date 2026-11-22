/// Boot-sequence tests: the shell must be on screen before the runtime is.
///
/// A cold start unpacks 16 452 files, so "wait for the host, then runApp" left
/// the user looking at a blank window. These tests pin the new contract: first
/// frame always renders, the startup banner explains what is happening, and it
/// disappears the moment the bridge attaches.

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/host_boot.dart';
import 'package:dsh_native/main.dart';
import 'package:dsh_native/plugin_manager.dart';
import 'package:dsh_native/unix_bridge.dart';

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
  setUp(() {
    HostBootstrap.status.value = '正在解压运行时 (3500/16452)';
  });

  testWidgets('first frame renders the shell with a startup banner', (tester) async {
    await asAndroid(() async {
      final host = ValueNotifier<UnixHarnessBridge?>(null);
      await tester.pumpWidget(DshApp(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: host,
      ));
      await tester.pump();

      // The shell is already there — this is the part that used to be blank.
      expect(find.text('会话'), findsOneWidget);
      expect(find.byKey(const Key('host-startup-banner')), findsOneWidget);
      expect(find.text('正在解压运行时 (3500/16452)'), findsOneWidget);

      // Attaching the bridge removes the banner without touching any screen.
      host.value = UnixHarnessBridge(socketPath: '/tmp/dsh-test.sock', token: 'test-token');
      await tester.pump();
      expect(find.byKey(const Key('host-startup-banner')), findsNothing);
      expect(find.text('会话'), findsOneWidget);

      // Unmount with the bridge still attached so DshApp.dispose() closes it.
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  testWidgets('banner text follows the host status', (tester) async {
    await asAndroid(() async {
      final host = ValueNotifier<UnixHarnessBridge?>(null);
      await tester.pumpWidget(DshApp(
        boot: BootData(plugins: PluginRegistry.empty()),
        host: host,
      ));
      await tester.pump();
      expect(find.text('正在解压运行时 (3500/16452)'), findsOneWidget);

      HostBootstrap.status.value = '正在启动 agent';
      await tester.pump();
      expect(find.text('正在启动 agent'), findsOneWidget);
      expect(find.text('正在解压运行时 (3500/16452)'), findsNothing);

      HostBootstrap.status.value = '启动失败：unpack failed: no space left on device';
      await tester.pump();
      expect(find.text('启动失败：unpack failed: no space left on device'), findsOneWidget);
    });
  });
}
