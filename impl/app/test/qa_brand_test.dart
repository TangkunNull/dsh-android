/// QA 独立验证：侧栏品牌的几何与配色（F 节「深色模式下反白是否还对」）。
///
/// 数据一致性（path 字符串与 bundle 逐字符比对）不在这里 —— 那是 D 节，用脚本
/// 对打包产物做的，见报告。这里断言的是**用到这些数据的地方**：
///   * 鲸鱼 24 宽 → 高 24 × 17.04 / 23.16（不能拉伸）；
///   * 字标 24 高 → 宽 24 × 156/24；
///   * 侧栏里鲸鱼的左缘落在 16px（侧栏根 8 + logoRow 8）；
///   * 反白胶囊在两种主题下都有足够对比度。
library qa_brand;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/brand_mark.dart';
import 'package:dsh_native/dsh_tokens.dart';
import 'package:dsh_native/session_list.dart';

double _contrast(Color a, Color b) {
  final la = a.computeLuminance();
  final lb = b.computeLuminance();
  final hi = la > lb ? la : lb;
  final lo = la > lb ? lb : la;
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  testWidgets('鲸鱼 24 宽、等比高度；字标 24 高、宽 156', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const FishLogo(size: 24, color: Colors.black),
            BrandWordmark(
                size: 24, color: Colors.black, invertedColor: Colors.white),
          ],
        ),
      ),
    ));

    final fish = tester.getSize(find.byType(FishLogo));
    final wordmark = tester.getSize(find.byType(BrandWordmark));
    print('[qa] fish=${fish.width}x${fish.height} '
        'wordmark=${wordmark.width}x${wordmark.height}');

    expect(fish.width, 24);
    expect(fish.height, closeTo(24 * 17.04 / 23.16, 0.01),
        reason: '高度必须是 size * 17.04 / 23.16');
    expect(wordmark.height, 24);
    expect(wordmark.width, closeTo(24 * 156 / 24, 0.01));
  });

  testWidgets('侧栏里鲸鱼的左缘是 16px', (tester) async {
    tester.binding.window.physicalSizeTestValue = const Size(420, 900);
    tester.binding.window.devicePixelRatioTestValue = 1;
    addTearDown(tester.binding.window.clearPhysicalSizeTestValue);

    await tester.pumpWidget(MaterialApp(
      home: SessionListScreen(sessions: const [], loading: false),
    ));
    await tester.pump();

    final logo = tester.getTopLeft(find.byType(FishLogo));
    print('[qa] fish left=${logo.dx} top=${logo.dy}');
    expect(logo.dx, 16, reason: '侧栏根 8 + logoRow 8 = 16，和上游一致');
  });

  test('反白胶囊：两种主题下都够对比', () {
    for (final entry in <String, DshTokens>{
      'light': DshTokens.lightTheme,
      'dark': DshTokens.darkTheme,
    }.entries) {
      final rect = entry.value.labelPrimary; // 胶囊底色（currentColor）
      final letters = entry.value.onPrimary; // --dsw-alias-label-primary-inverted
      final ratio = _contrast(rect, letters);
      print('[qa] ${entry.key}: badge=${rect.value.toRadixString(16)} '
          'letters=${letters.value.toRadixString(16)} '
          'contrast=${ratio.toStringAsFixed(2)}');
      expect(letters, isNot(rect));
      expect(ratio, greaterThan(4.5),
          reason: '${entry.key} 下 "HARNESS" 反白字读不出来');
    }
  });
}
