# NOTICE

## 本项目

DSH Android —— 把 DeepSeek Harness 搬到 Android 的移植与原生渲染层。

```
Copyright (c) 2026 TangkunNull
SPDX-License-Identifier: AGPL-3.0-only
```

本仓库除下列第三方部分外，均以 [AGPL-3.0](LICENSE) 授权；需要闭源商用须另行取得授权（[COMMERCIAL.md](COMMERCIAL.md)）。

## 随 APK 分发的第三方组件

| 组件 | 版本 | 许可证 | 位置 |
|---|---|---|---|
| Node.js（`libnode.so`，含 V8 / libuv / OpenSSL / ICU） | 24.20.0 | MIT | `impl/android/runtime/src/main/jniLibs/arm64-v8a/` |
| Flutter 引擎与框架 | 3.x | BSD-3-Clause | `impl/app/` |
| cordis | 见 `runtime.zip` 内 `package.json` | MIT | 运行时闭包 |
| DeepSeek Harness 运行时闭包及其依赖 | 见各包 `package.json` | 各自许可证 | `assets/runtime.zip`（构建时生成，不入库） |

上游代码的版权归各自作者所有。本项目只做打包与适配，未修改其源码；对这些组件的使用不改变它们原有的许可证，也不代表原作者对本项目的授权背书。

## 测试夹具中的第三方代码

`impl/fixtures/` 下的内容来自社区，**不在本项目许可证范围内**，版权归各自作者：

| 目录 | 说明 | 许可证 |
|---|---|---|
| `impl/fixtures/plugins/*`（28 个插件） | DeepSeek Harness 社区插件，作为渲染兼容性测试样本随附 | 未声明（默认保留所有权利，仅作测试样本使用） |
| `impl/fixtures/dsh-windows-mcp/` | [helloHub1212/dsh-windows-mcp](https://github.com/helloHub1212/dsh-windows-mcp) | MIT |

这些目录仅用于验证协议与渲染兼容性，不参与主程序逻辑；其授权条件以各自作者为准。

## 字体与图标

应用图标由本项目作者绘制。界面字体使用系统字体，未内嵌第三方字体文件。

## 商标

「DeepSeek」「DSH」等名称与标识归其权利人所有。本项目是非官方移植，与上游无隶属关系。
