import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dsh_native/renderer.dart';
import 'package:dsh_native/slots.dart';

Future<void> loadCjk() async {
  // flutter_test ships Ahem (every glyph a box); load a real CJK face so the
  // snapshot says something about typography and line breaking.
  final bytes = File('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc').readAsBytesSync();
  final loader = FontLoader('NotoCJK')..addFont(Future<ByteData>.value(ByteData.view(bytes.buffer)));
  await loader.load();
}

void main() {
  final bundle = SlotBundle.fromString(File('assets/slots.json').readAsStringSync());
  setUpAll(loadCjk);

  Widget wrap(Widget child, {Size size = const Size(390, 200)}) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: ThemeData(useMaterial3: true, fontFamily: 'NotoCJK', colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF3B82F6))),
        home: Scaffold(
          backgroundColor: Colors.white,
          body: SizedBox(width: size.width, height: size.height, child: Padding(padding: const EdgeInsets.all(12), child: Align(alignment: Alignment.topLeft, child: child))),
        ),
      );

  testWidgets('golden: composer pill', (tester) async {
    await tester.binding.setSurfaceSize(const Size(240, 80));
    final ir = bundle['conversation.input.left']!;
    await tester.pumpWidget(wrap(IrRenderer(onEvent: (_) {}).build(ir), size: const Size(240, 80)));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/pill.png'));
    await tester.binding.setSurfaceSize(null);
  });

  testWidgets('golden: settings section', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 260));
    final ir = bundle['plugins.bundle.activation']!;
    await tester.pumpWidget(wrap(IrRenderer(onEvent: (_) {}).build(ir), size: const Size(390, 260)));
    await expectLater(find.byType(MaterialApp), matchesGoldenFile('goldens/settings.png'));
    await tester.binding.setSurfaceSize(null);
  });
}
