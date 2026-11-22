// Harness 入口，由 libnode 在 `:harness` 进程里跑。
//
// 职责（就这些，别的都别塞进来）：
//   1. 算出 socket 与 discovery 文件的位置；
//   2. 先把 bridge 起起来；
//   3. 再把 dsh 本体起在同进程里，拿到 gateway 就接上；
//   4. dsh 起不来时**不拖死 bridge**，把失败推给 Flutter 并写 stderr。
//
// 顺序是有原因的。先 listen 再 boot dsh，Flutter 才能收到「后端没起来」这个
// 事实；反过来它只会看到一个连不上的 socket，看上去像网络问题。
//
// 所有协议形状的东西都在 `node/host/` 里（由 tools/sync-harness-assets.mjs 拷到
// 本脚本旁边），这里不打包：进程里没有 source map，打包会把「这个栈来自哪个
// 模块」这件事一起藏掉。
//
// 同进程的意义：Flutter 侧和 dsh 都在这一个 libnode 实例里，所以 bridge 不需要
// 再走 http://127.0.0.1:7020 —— 没有端口、没有 launch token、没有 cookie。
// 本机桌面调试没有「同进程的 dsh」，所以 DSH_BASE_URL 那条 HTTP 路径保留着。

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const TAG = '[harness]';

function log(...args) {
  // stdout/stderr 由 HarnessService 捕获后追加进 harness.log，所以 console.log 就是日志。
  console.log(TAG, ...args);
}

function envPath(name) {
  const v = process.env[name];
  return v && v.length > 0 ? v : null;
}

/**
 * dsh 本体的模块源。
 *
 * 不用裸 `import('@deepseek-ai/...')`：它的解析基准是**本文件所在目录**，而设备上
 * 那份 node_modules 不一定在那条向上的链里。候选根按「部署时的真实位置」排：
 *   DSH_MODULES → DSH_ROOT → $DSH_HOME/profiles/<profile> → cwd → 本脚本目录。
 * 首个能解析到的胜出，解析到的是同一个包实例（ESM 的裸名再解析从它自己的目录走）。
 */
function dshModuleRoots(profile) {
  const explicit = [envPath('DSH_MODULES'), envPath('DSH_ROOT')];
  const home = envPath('DSH_HOME');
  if (home) explicit.push(path.join(home, 'profiles', profile));
  explicit.push(process.cwd(), __dirname);
  return [...new Set(explicit)];
}

function resolveDshModule(spec, profile) {
  const failures = [];
  for (const root of dshModuleRoots(profile)) {
    try {
      return createRequire(path.join(root, 'noop.cjs')).resolve(spec);
    } catch (e) {
      failures.push(`${root}: ${e && e.code ? e.code : e}`);
    }
  }
  throw new Error(`cannot resolve ${spec} (looked in ${failures.join('; ')})`);
}

async function importDsh(spec, profile) {
  return import(pathToFileURL(resolveDshModule(spec, profile)).href);
}

/**
 * 起 dsh 本体。
 *
 * 返回 { ctx, shutdown, gateway, connection }；`shutdown.shutdown(code)` 是 profile
 * 自己的关停入口。`DSH_HOME` 由宿主设好，`loadLayeredEnv('dsh')` 读的就是它。
 */
async function startDsh(profile) {
  const { loadLayeredEnv } = await importDsh('@deepseek-ai/dsh-app-boot', profile);
  const { runProfile } = await importDsh('@deepseek-ai/dsh/profile-boot', profile);

  log('booting dsh', { profile, home: envPath('DSH_HOME') ?? '(unset)' });
  const runtime = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile,
    patchFiles: [],
    args: [],
  });

  const gateway = runtime.ctx.get('typertGateway');
  const connection = runtime.ctx.get('connection');
  if (!gateway) throw new Error('dsh profile did not provide typertGateway');
  if (!connection) throw new Error('dsh profile did not provide connection');
  return { ...runtime, gateway, connection };
}

async function main() {
  // cwd 由 NodeRuntime.start(workDir) 设成 app 的 files 目录；显式覆盖优先，
  // 这样同一个脚本也能在桌面上跑。
  const workDir = envPath('DSH_WORK_DIR') || process.cwd();
  const socketPath = envPath('DSH_SOCKET') || path.join(workDir, 'harness.sock');
  const endpointPath = envPath('DSH_ENDPOINT') || path.join(workDir, 'harness.endpoint.json');
  // 桌面调试用的 HTTP 兜底；同进程成功时它不会被用到（bridge 会记一条 log）。
  const baseUrl = envPath('DSH_BASE_URL') || null;
  const token = envPath('DSH_TOKEN') || null;
  const profile = envPath('DSH_PROFILE') || 'android';

  if (!fs.existsSync(workDir)) {
    throw new Error(`work dir does not exist: ${workDir}`);
  }

  // libnode 嵌入式入口从内存执行脚本：__dirname 是进程路径（/system/bin），
  // 不是脚本目录 —— 桥模块按 __dirname 找必然落空（设备日志证实）。
  // Java 侧显式传解包目录；桌面直接 node 跑时无此变量，退回 __dirname。
  const harnessDir = envPath('DSH_HARNESS_DIR') || __dirname;
  const modPath = path.join(harnessDir, 'node', 'host', 'bridge-server.mjs');
  if (!fs.existsSync(modPath)) {
    throw new Error(`bridge module missing: ${modPath} (run tools/sync-harness-assets.mjs)`);
  }
  const { createBridgeServer } = await import(pathToFileURL(modPath).href);

  const server = createBridgeServer({
    socketPath,
    endpointPath,
    token,
    linkOptions: {
      // baseUrl 为空时 session-link 用 transport 自己的默认值；同进程成功则忽略。
      ...(baseUrl ? { baseUrl } : {}),
      onLog: (tag, info) => log('link', tag, info === undefined ? '' : JSON.stringify(info)),
    },
    onLog: (tag, info) => log(tag, info === undefined ? '' : JSON.stringify(info)),
  });

  // ---- 先有 socket，再有后端 --------------------------------------------
  await server.listen();
  log('listening', socketPath, 'transport', server.transportKind, 'pid', process.pid);

  let runtime = null;
  // 原生绑定自检：在 dsh boot 之前加载 android 绑定包，dsh-app-boot 会把底层
  // 错误包装重抛（attempts 挂在 cause 链上被吞），这里的原始错误就是 dlopen 的
  // 第一手报错（见 docs/07-harmonyos.md）。
  //
  // 为什么不用裸 require()：harness.js 由嵌入式入口的 embedderRequire 加载，
  // 那条链上的 require 只认内置模块、不解析 node_modules（设备实测里
  // "No such built-in module" 的误报就是这么来的）。用 createRequire 以运行
  // 目录为基准解析，走的就是与 boot 一致的 node-addon-native-custom-loader
  // 路径，报错是 dlopen 级的第一手信息。
  try {
    const require2 = createRequire(path.join(harnessDir, 'noop.cjs'));
    const addon = require2('node-addon-require-builtin-android-arm64');
    log('narb selfcheck ok', addon.getBindingInfo ? 'entry api loaded' : 'loaded');
  } catch (e) {
    console.error(TAG, 'narb selfcheck failed', e && e.stack ? e.stack : String(e),
      e && e.attempts ? JSON.stringify(e.attempts) : '');
  }
  // ---- Intl polyfill：必须在 boot 之前 -----------------------------------
  // 设备上的 libnode 是 nodejs-mobile 的 --with-intl=none 构建：V8 编的时候
  // v8_enable_i18n_support=0，二进制里没有任何 ICU 代码，globalThis.Intl 是
  // undefined（不是空对象）。dsh 的插件在**模块顶层**就引用它（@js-temporal/
  // polyfill 的 `const ct = Intl.DateTimeFormat`、dsh-llm-deepseek 的
  // `new Intl.Segmenter(...)`），所以必须在任何插件被 import 之前补齐，晚一步
  // 就是 `ReferenceError: Intl is not defined`（设备实测：13 个插件全挂）。
  //
  // 桌面 node 自带完整 ICU，这里会跳过，不浪费 140ms。
  const intlPolyfillPath = path.join(harnessDir, 'node_modules', 'dsh-intl-polyfill', 'intl-polyfill.mjs');
  if (typeof globalThis.Intl?.DateTimeFormat === 'function') {
    log('intl native present, polyfill skipped');
  } else if (!fs.existsSync(intlPolyfillPath)) {
    // 老 runtime 里没这个文件：记一条，别让整个启动挂在这（dsh 自己还能跑，
    // 只是依赖 Intl 的插件会失败 —— 那种失败在 boot 之后的日志里能看到）。
    log('intl polyfill missing', intlPolyfillPath);
  } else {
    const intlT0 = Date.now();
    await import(pathToFileURL(intlPolyfillPath).href);
    const apiOk = ['DateTimeFormat', 'DurationFormat', 'Segmenter', 'ListFormat',
      'NumberFormat', 'PluralRules', 'DisplayNames', 'Locale', 'supportedValuesOf']
      .filter((k) => typeof globalThis.Intl?.[k] === 'function').length;
    log('intl polyfill loaded', {
      ms: Date.now() - intlT0,
      api: `${apiOk}/9`,
      timezones: globalThis.Intl?.supportedValuesOf?.('timeZone')?.length ?? 0,
    });
  }

  // ---- 中文 locale 补丁：small-icu 只有 en 数据 ---------------------------
  // full 版 libnode 是 small-icu：Intl 存在、时区完整，但中文 locale 数据没有，
  // zh-CN 请求会静默按 en 输出（"November 20, 2026"）。这里在 boot 之前把默认
  // locale 的输出换成中文；桌面完整 ICU 下自检会发现中文可用并整体跳过。
  const zhPatchPath = path.join(harnessDir, 'node_modules', 'dsh-intl-zh', 'zh.mjs');
  if (fs.existsSync(zhPatchPath)) {
    try {
      const mod = await import(pathToFileURL(zhPatchPath).href);
      log('intl zh patch', mod.__info ?? { enabled: 'unknown' });
    } catch (e) {
      log('intl zh patch failed', e && e.message ? e.message : String(e));
    }
  } else {
    log('intl zh patch missing', zhPatchPath);
  }

  try {
    runtime = await startDsh(profile);
    server.attachGateway({ gateway: runtime.gateway, connection: runtime.connection });
    log('dsh attached', { profile, transport: server.transportKind });
  } catch (e) {
    // 不退出：bridge 还活着，Flutter 会收到一条 backend-unavailable，
    // harness.log 里留下完整栈。
    console.error(TAG, 'dsh boot failed', e && e.stack ? e.stack : String(e));
    // dsh-app-boot 会包装重抛：attempts 可能挂在 cause 链的任何一层，递归找。
    let cur = e, depth = 0, attempts;
    while (cur && typeof cur === 'object' && depth++ < 10) {
      if (cur.attempts) { attempts = cur.attempts; break; }
      cur = cur.cause;
    }
    if (attempts) {
      console.error(TAG, 'dsh boot failed attempts', JSON.stringify(attempts));
    }
    server.notifyBackendFailure(e);
  }

  const shutdown = async (why) => {
    log('shutting down:', why);
    try {
      await server.close();
    } catch (e) {
      log('close failed', e && e.message);
    }
    try {
      await runtime?.shutdown?.shutdown?.(0);
    } catch (e) {
      log('dsh shutdown failed', e && e.message);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 显式保活：今天 server 撑着事件循环，但将来重构成关掉 server 时，
  // 不能让进程在 UI 还认为 runtime 活着的时候悄悄退出。
  setInterval(() => {}, 1 << 30);
}

process.on('uncaughtException', (err) => {
  console.error(TAG, 'uncaught', err && err.stack ? err.stack : String(err));
});
process.on('unhandledRejection', (err) => {
  console.error(TAG, 'unhandled rejection', err && err.stack ? err.stack : String(err));
});

main().catch((e) => {
  console.error(TAG, 'fatal', e && e.stack ? e.stack : String(e));
  process.exit(1);
});
