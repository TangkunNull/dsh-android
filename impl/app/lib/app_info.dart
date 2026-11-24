/// 应用版本，构建时注入。
///
/// 侧栏和设置页都要显示版本号，之前两处各自写死 `0.1.0-p3`，改了 pubspec 也
/// 不会动 —— 用户看到"设置里的版本跟装的包对不上"，第一反应是装错了包。
///
/// 现在由 `build_apk.sh` 从 `pubspec.yaml` 读出来，用 `--dart-define` 传进来，
/// 与探针包的 versionName 是同一个来源。默认值只服务于 `flutter test` 与
/// `flutter run`（那两条路径不经过构建脚本）。
const String appVersion = String.fromEnvironment(
  'APP_VERSION',
  defaultValue: '0.1.17',
);
