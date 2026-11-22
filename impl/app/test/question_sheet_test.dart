/// Tests for the ask-user surface.
///
/// The contract under test is narrow but load-bearing: the host blocks a turn
/// until it receives exactly one answer batch, so every exit from this sheet —
/// including "跳过" — must produce one.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:dsh_native/client.dart';
import 'package:dsh_native/question_sheet.dart';

Future<List<List<QuestionAnswer>>> pumpSheet(
  WidgetTester tester,
  List<AskQuestion> questions,
) async {
  final batches = <List<QuestionAnswer>>[];
  await tester.pumpWidget(MaterialApp(
    home: Scaffold(
      body: QuestionSheet(
        questions: questions,
        onSubmit: batches.add,
      ),
    ),
  ));
  return batches;
}

const branchQ = AskQuestion(
  id: 'q1',
  title: '用哪个分支？',
  options: [
    AskOption(value: 'main', label: 'main'),
    AskOption(value: 'dev', label: 'dev'),
  ],
);

void main() {
  testWidgets('renders every question and its options', (tester) async {
    await pumpSheet(tester, const [
      branchQ,
      AskQuestion(id: 'q2', title: '要不要跑测试？', options: [
        AskOption(value: 'yes', label: '跑'),
        AskOption(value: 'no', label: '不跑'),
      ]),
    ]);

    expect(find.text('用哪个分支？'), findsOneWidget);
    expect(find.text('要不要跑测试？'), findsOneWidget);
    expect(find.text('main'), findsOneWidget);
    expect(find.text('不跑'), findsOneWidget);
  });

  testWidgets('single-select keeps only the last pick', (tester) async {
    final batches = await pumpSheet(tester, const [branchQ]);

    await tester.tap(find.text('main'));
    await tester.pump();
    await tester.tap(find.text('dev'));
    await tester.pump();
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();

    expect(batches.single.single.id, 'q1');
    expect(batches.single.single.selected, ['dev']);
  });

  testWidgets('multi-select accumulates', (tester) async {
    final batches = await pumpSheet(tester, const [
      AskQuestion(
        id: 'q1',
        title: '选哪些？',
        multiSelect: true,
        options: [AskOption(value: 'a', label: 'A'), AskOption(value: 'b', label: 'B')],
      ),
    ]);

    await tester.tap(find.text('A'));
    await tester.pump();
    await tester.tap(find.text('B'));
    await tester.pump();
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();

    expect(batches.single.single.selected, ['a', 'b']);
  });

  testWidgets('free text goes out as custom and clears the picks', (tester) async {
    final batches = await pumpSheet(tester, const [branchQ]);

    await tester.tap(find.text('main'));
    await tester.pump();
    await tester.enterText(find.byType(TextField), '  release/1.2  ');
    await tester.pump();
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();

    final a = batches.single.single;
    expect(a.custom, 'release/1.2', reason: 'must be trimmed');
    expect(a.selected, isEmpty, reason: 'custom and selected cannot disagree');
  });

  testWidgets('a question with no options still offers a text field', (tester) async {
    final batches = await pumpSheet(tester, const [
      AskQuestion(id: 'q1', title: '项目名叫什么？'),
    ]);

    expect(find.text('你的回答'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'dsh-android');
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();

    expect(batches.single.single.custom, 'dsh-android');
  });

  testWidgets('skip sends an empty batch instead of closing silently', (tester) async {
    final batches = await pumpSheet(tester, const [branchQ]);

    await tester.tap(find.text('跳过'));
    await tester.pumpAndSettle();

    expect(batches, hasLength(1));
    expect(batches.single.single.id, 'q1');
    expect(batches.single.single.selected, isEmpty);
  });

  testWidgets('a question without an id cannot be submitted', (tester) async {
    await pumpSheet(tester, const [
      AskQuestion(id: '', title: '无 id 的问题', options: [AskOption(value: 'x', label: 'X')]),
    ]);

    final button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
    expect(button.onPressed, isNull, reason: 'answering a guessed id is worse than not answering');
    expect(find.textContaining('缺少 id'), findsOneWidget);
  });

  testWidgets('two questions produce two answers in one batch', (tester) async {
    final batches = await pumpSheet(tester, const [
      branchQ,
      AskQuestion(id: 'q2', title: '跑测试吗？', options: [AskOption(value: 'yes', label: '跑')]),
    ]);

    await tester.tap(find.text('dev'));
    await tester.pump();
    await tester.tap(find.text('跑'));
    await tester.pump();
    await tester.tap(find.text('提交'));
    await tester.pumpAndSettle();

    expect(batches.single, hasLength(2));
    expect(batches.single[0].selected, ['dev']);
    expect(batches.single[1].selected, ['yes']);
  });
}
