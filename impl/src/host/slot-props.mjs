// 宿主 props 注入器：把「插件组件期望从 props 拿到的那一整套东西」造出来。
//
// ── 为什么需要这一层 ────────────────────────────────────────────────────────
// 真实插件的插槽组件长这样（`dsh-client-ui-settings-plugins/lib/client.js`）：
//
//   function PluginsSettingsSection({ t, renderSlot, useTabs }) {
//     const rows = useTabs((value) => value);
//     ...
//   }
//
// 这些 `useXxx` **不是 import**，是宿主通过 props 注入的（上游的运行时把
// store / 服务 / 插槽渲染器都翻译成 hook 塞进组件）。我们只传
// `{ __ctx, sessionId }` 的话，组件第一句就 `useTabs is not a function`，
// 抛在 reconciler 的 render 里 → 整棵子树变空。这就是"装上插件什么都不显示"
// 的第二层根因（第一层是 primitives 用替身，见 host/index.mjs REAL_SPECS）。
//
// 这一轮的目标不是"让数据正确"（那要跑上游 runtime，见 roadmap），而是
// **让组件不因为拿不到 hook 而崩溃**，把能渲染的结构先渲染出来，并把
// "哪个 hook 还是空态"记录成下一轮的输入。
//
// ── 三条设计约束 ────────────────────────────────────────────────────────────
// 1. 必须是**普通对象**，不能是 Proxy。组件内部普遍 `{...props}` 再传给子组件，
//    展开只复制 own enumerable 键 —— Proxy 的 get 陷阱在展开时全部丢失，
//    动态生成的名字一个都过不去。所以所有 hook 都用 Object.defineProperties
//    写成真正的 own property。
// 2. hook 的调用形状统一为 `(selector?) => snapshot`：插件里
//    `useStore((state) => state.open)` 这种选择器调用是主流（73 处），返回整个
//    快照则兼容 `const tabs = useTabs()`。
// 3. 快照本身在模块加载时创建**一次**，不在每次调用时新建。`useSyncExternalStore`
//    一类的调用按引用比较，每次返回新对象就是无限重渲染（locale.mjs 里
//    getSnapshot 踩过同一个坑）。
//
// ── 默认值从哪来 ────────────────────────────────────────────────────────────
// HOOK_NAMES 是 `tools/extract-hooks.mjs` 从 60 个已发布插件的 lib/client.js
// 里逐字抽出来的（196 个名字，排除 React 自带的 18 个）。SHAPES 是其中能确认
// 返回值形状的那些；确认不了的一律 undefined —— 猜一个形状比返回 undefined 更糟：
// `if (!session) return null` 会因为一个假对象变成"渲染出一堆 undefined"。
import * as React from 'react';

import * as locale from './locale.mjs';

/** 插槽递归深度上限。真实 renderSlot 靠 entry 声明的 children 表做所有权校验，
 *  我们只有一张平坦的名字表，所以用深度 + 路径两道闸防止 A 渲染 A。 */
const MAX_DEPTH = 6;

/** 空列表。每个 hook 一份独立数组：组件对返回值排序/裁剪时不会污染别人。 */
const list = () => [];

/** 什么都不做的动作。`onFoo` / `install` / `refresh` 这类签名先满足"存在且可调用"。 */
const noop = () => {};

/**
 * 名字像"一组东西"的 hook → 空数组。
 *
 * 依据：`useTabs` / `usePanels` / `usePlans` / `useModels` … 在插件里几乎都是
 * `rows.map(...)` 或 `if (rows.length === 0) return <Empty/>`。返回空数组让
 * 组件走"空状态"分支 —— 那是一个真实、正确的界面，只是没有数据。
 *
 * 结尾的 `s` 要排掉 `-us` / `-is` 两种词尾：`useStatus`、`useAnalysis` 是单数，
 * 给它们空数组会让 `state.value` 这条链直接断掉（数组上没有 value）。
 */
const PLURAL = /(?:(?<![iu])s|List|Entries|Items|Rows|Steps|Views|Pages|Cards|Options|Presets|Types|Ids|Tabs|Panels|Sections|Bodies|Jobs|Plans|Models|Sessions|Workspaces|Skills|Shortcuts|Notices|Failures|Errors|Uploads|Previews|Applications|Runs|Pins|Details|Drafts|Facts|Labels|Stats|Values|Atoms)$/;

/**
 * 已知返回值形状的 hook。
 *
 * 每一项都来自**读真实调用点**，不是凭名字猜：
 *   useTabInfo()          -> `const { tab } = useTabInfo()` / `const { tab, panel }`
 *   usePanelInfo()        -> `const { panel } = usePanelInfo()`
 *   useDisclosure()       -> `const { expanded, toggle } = useDisclosure()`
 *   useContextMenu()      -> `const { getTriggerProps } = useContextMenu()`
 *   useTabs()             -> 元素 `{ id, label }`（settings-plugins 拿 row.id 去 renderSlot）
 *   useDiscover()         -> `state.status === 'idle' | 'loading' | 'error'`
 *   useLocale()           -> `{ active, locale }`
 *   useTheme()            -> `{ mode, isDark }`
 *   useAccess / useSessionAccess / useWorkspaceAccess / useCanOpen -> 布尔
 *   useProjection()       -> `useProjection("actionCards")` 取一个投影，空态 undefined
 */
const SHAPES = {
  // ── 插槽/tab 结构 ──
  useTabs: list,
  usePluginTabs: list,
  useTabTypes: list,
  useTabNavigation: list,
  usePanels: list,
  usePanelInfo: () => ({ panel: { id: 'dsh.panel', title: '', icon: null }, tab: null }),
  useTabInfo: () => ({ tab: { id: 'dsh.tab', title: '', icon: null }, panel: null }),
  useSections: list,
  useViews: list,
  usePage: () => null,
  usePlatformPage: () => null,

  // ── 交互状态 ──
  useDisclosure: () => ({
    expanded: false, open: false, isOpen: false,
    setExpanded: noop, toggle: noop, setOpen: noop, onToggle: noop, close: noop,
  }),
  useContextMenu: () => ({ getTriggerProps: () => ({}), open: noop, close: noop, isOpen: false }),
  useContextMenuTarget: () => ({ target: null, setTarget: noop, clear: noop }),
  useMenuOpenState: () => ({ open: false, setOpen: noop, toggle: noop }),
  useDialog: () => ({ open: false, setOpen: noop, close: noop }),
  useModalLayer: () => ({ layer: 0, register: noop, unregister: noop }),
  useQuestionCard: () => null,
  useStatDialog: () => ({ open: false, openDialog: noop, closeDialog: noop }),

  // ── 插件市场 ──
  // `plugin-market` 的渲染分支完全由 status 决定：
  //   idle → 搜索框；loading → 骨架；error → 重试。给 'idle' 是最"安静"的一档。
  useDiscover: () => ({ status: 'idle', items: [], error: null, query: '', reload: noop }),
  useDetails: () => null,
  useBundleDetails: () => null,
  usePluginManager: () => ({ plugins: [], install: noop, remove: noop, refresh: noop }),

  // ── locale / theme ──
  useLocale: () => ({ active: 'zh', locale: 'zh', fallback: 'en' }),
  useLocaleRevision: () => 0,
  useTheme: () => ({ mode: 'light', isDark: false, scheme: 'light' }),
  useLexicon: () => ({}),

  // ── 权限 / 可用性（布尔）──
  useAccess: () => true,
  useSessionAccess: () => true,
  useWorkspaceAccess: () => true,
  useCanOpen: () => false,
  useBrowserAvailable: () => false,
  usePermission: () => true,
  useRemoteAccess: () => true,
  useLoaded: () => true,
  useNativeDragAcceptance: () => false,
  useShowCodeDiff: () => false,
  useFoldedLandscape: () => false,

  // ── 投影 / 派生数据 ──
  useProjection: () => undefined,
  usePresentation: () => undefined,
  useSnapshot: () => undefined,
  useStore: () => undefined,
  useSelector: () => undefined,
  useSession: () => undefined,
  useSessions: () => undefined,
  useSessionStatus: () => undefined,
  useConversation: () => undefined,
  useChat: () => undefined,
  useHost: () => undefined,
  useHostInfo: () => ({ platform: 'android', version: '0.0.0', native: true }),
  useConnectionState: () => ({ status: 'connected', online: true }),
  useTurnData: () => undefined,
  useTurnDataValue: () => undefined,
  useVirtualizer: () => ({ virtualItems: [], totalSize: 0, measureElement: noop, scrollToIndex: noop, getScrollElement: () => null }),
  useCodeHighlighter: () => ({ highlight: () => [], codeToTokens: () => ({ tokens: [] }) }),
};

/** 196 个 hook 名，`tools/extract-hooks.mjs` 生成。顺序不影响语义。 */
export const HOOK_NAMES = Object.freeze([
  'useStore', 'useSessions', 'useContextMenu', 'useTabInfo',
  'useSession', 'useProjection', 'useAnchoredPosition', 'useDismissOnOutsidePointer',
  'useShortcuts', 'usePanelInfo', 'useSessionStatus', 'useWorkspaces',
  'useAccess', 'useCatalog', 'useResource', 'useConversation',
  'useFactorySlot', 'useEntryActions', 'useEntryPins', 'useToast',
  'useDisclosure', 'useSessionAccess', 'useContextMenuTarget', 'useRemoteAccess',
  'useApiKey', 'useLocale', 'useConnectionState', 'useDeveloperTools',
  'useSnapshot', 'useHostInfo', 'useRowDragPreview', 'useAnchoredMaxHeight',
  'useClipboardCopy', 'useDetailDocumentLabels', 'useModalLayer', 'useVirtualizer',
  'usePresentation', 'useGroupAction', 'useChat', 'useSearchApi',
  'useAccount', 'useActualDuration', 'useHost', 'useChangesDiff',
  'useChatGroup', 'useEqualWidth', 'useSearchApiHint', 'usePerformanceUsage',
  'useChatNode', 'useDirectoryFlow', 'useScopeBinding', 'useTabNavigation',
  'useWorkspaceAccess', 'useInventory', 'useLoaded', 'useTheme',
  'useChatNodeBottom', 'useChatNodeProcess', 'useConfig', 'useDetails',
  'useFixedCatalog', 'useGroupHeaderAction', 'useInput', 'useRootBinding',
  'useTabTypes', 'useActiveRuns', 'useAgentPresets', 'useArchived',
  'useBusyEnter', 'useChangesSummary', 'useConversationViews', 'useDesktopUpdate',
  'useLocaleRevision', 'useMaybeIncarnation', 'useModelRows', 'useMutation',
  'usePresentedHost', 'usePresentedOpen', 'useQuestionCard', 'useStatDialog',
  'useViews', 'useFeedback', 'useFileApplications', 'useFlash',
  'useFlowTransition', 'useGoalActivation', 'useInstallComposition', 'useJobs',
  'useLongestToken', 'useNativeDragAcceptance', 'useNotices', 'usePluginManager',
  'useRelativeClock', 'useScrollFollow', 'useSessionScheduleFacts', 'useTaskDetail',
  'useTaskTabTarget', 'useTurnData', 'useAbsentSnapshot', 'useAgentPresetSeat',
  'useAgentPresetSection', 'useArchiveRequest', 'useBodies', 'useBrowserAvailable',
  'useBrowserDraft', 'useBrowserState', 'useCalendarDay', 'useCanOpen',
  'useChatNavigation', 'useChatReading', 'useChatScroll', 'useChatViewport',
  'useClientSync', 'useCollapseTiming', 'useComposerBlock', 'useDialog',
  'useDocumentPreviews', 'useDuration', 'useFactorySlotRuntime', 'useFailure',
  'useFileUploads', 'useFlowHidden', 'useFoldedLandscape', 'useFoldedReplies',
  'useGithubMirror', 'useGuideEntries', 'useInspectCall', 'useInteractionIds',
  'useInteractivePreview', 'useLexicon', 'useLinkOpening', 'useMenuLauncher',
  'useModels', 'useMotionHidden', 'useNotice', 'useOnboarding',
  'useOnboardingSteps', 'useOpenInAppApps', 'useOpenInAppChoice', 'useOpenTargetGesture',
  'usePage', 'usePanels', 'usePermission', 'usePermissionCatalog',
  'usePinned', 'usePinState', 'usePlans', 'usePlatformPage',
  'usePluginNavigation', 'useProcessScroll', 'useReleaseChange', 'useRenameRequest',
  'useRenderFailures', 'useRowWidth', 'useRunCards', 'useRunErrors',
  'useSearchableHidden', 'useSections', 'useSessionRetainInfo', 'useSessionStats',
  'useShowCodeDiff', 'useSidebarMounted', 'useStableLiveProcessTitle', 'useStableVirtualRowStructure',
  'useStopShortcut', 'useSyncExternalStoreWithSelector', 'useTabs', 'useTerminal',
  'useTextInteraction', 'useTitleMarquee', 'useTodoHistory', 'useTrajectory',
  'useTranscriptView', 'useTurnDataValue', 'useUpload', 'useUserTextRevision',
  'useWelcome', 'useWorkspaceActionRequest', 'useWorkspaceShortcuts', 'useAgentLoopCard',
  'useBoundDisclosure', 'useBundleDetails', 'useCodeHighlighter', 'useConfigLedger',
  'useConfigurations', 'useDiscover', 'useMenuOpenState', 'useOpenInAppDesktop',
  'useOpenInAppLaunch', 'usePluginTabs', 'useScrollendEvent', 'useSelector',
  'useShellCard', 'useSubagentLimitsCard', 'useSubagentModelSelectionCard', 'useWebSearchCard',
]);

/**
 * 一个 hook 的默认快照。三级判定，先具体后笼统：
 *   1. SHAPES 里点名 → 用它（唯一有证据的一级）
 *   2. 名字是复数 / *List / *Entries → 空数组（走空状态分支，是真实界面）
 *   3. 其余 → undefined（不伪造数据：假对象会让 `if (!x)` 分支失效，渲染出乱码）
 */
export function defaultFor(name) {
  if (Object.prototype.hasOwnProperty.call(SHAPES, name)) return SHAPES[name]();
  if (PLURAL.test(name.replace(/^use/, ''))) return list();
  return undefined;
}

/** 把快照包成插件期望的调用形状：`(selector?) => snapshot`。 */
function hookFor(name, snapshot) {
  return function hostHook(selector) {
    if (typeof selector === 'function') {
      // 选择器可能对空态抛错（`s => s.items.map(...)`）。此时返回 undefined 而
      // 不是让整个组件炸掉 —— 一个 hook 的选择器写死了，不该拖垮整棵子树。
      try {
        return selector(snapshot);
      } catch {
        return undefined;
      }
    }
    return snapshot;
  };
}


/**
 * 造一份插槽组件用的 props。
 *
 * @param {object} opts
 * @param {object} [opts.ctx]      插件 apply 收到的 ctx（取 locale 服务用）
 * @param {object} [opts.services] 服务表（`get(name)`）
 * @param {object} [opts.slots]    插槽注册表（`list(name)`）
 * @param {object} [opts.extra]    额外要并进 props 的字段（`sessionId` 等）
 * @returns {object} 普通对象，196 个 hook + t + renderSlot 全是 own property
 */
export function createSlotProps({ ctx = null, services = null, slots = null, extra = {} } = {}) {
  const localeService = (() => {
    const fromCtx = ctx?.locale;
    if (fromCtx && typeof fromCtx.t === 'function') return fromCtx;
    const fromTable = services?.get?.('locale');
    if (fromTable && typeof fromTable.t === 'function') return fromTable;
    return locale;
  })();

  /** `t(key, vars)`：先问 ctx 上的 locale 服务，取不到回落 key 本身。
   *  回落是刻意的 —— 显示 "settings.title" 比显示空白更容易定位缺哪条文案。 */
  const t = (key, vars) => {
    try {
      const out = localeService.t(key, vars);
      return out == null ? key : out;
    } catch {
      return key;
    }
  };

  /**
   * `renderSlot(name, props?, opts?)` —— 把某个插槽里的条目渲染出来。
   *
   * 上游签名是 `renderSlot(key, props?, { only })`，`only` 是设置页用来
   * "只渲染我这一行对应的 tab"的（`dsh-client-ui-settings-plugins` 里
   * `renderSlot("settings.plugins.tab", {}, { only: row.id })`）。
   * 这里支持 string / array / 谓词三种 `only`，因为发布产物里三种都出现过。
   *
   * 返回数组（React 直接当 children 用）或 null。空插槽返回 null 而不是 []：
   * 上游组件会用 `children && <Wrapper>` 判断，空数组是真值，会渲染出空壳。
   */
  const renderSlot = (name, extraProps = {}, opts = {}) => {
    const entries = slots?.list ? slots.list(name) : [];
    if (!entries.length) return null;

    const only = opts?.only;
    const picked = only == null ? entries : entries.filter((entry) => {
      const id = entry?.meta?.id ?? entry?.meta?.key ?? entry?.meta?.name ?? null;
      if (typeof only === 'function') return only(entry);
      if (Array.isArray(only)) return only.includes(id);
      return id === only;
    });
    if (!picked.length) return null;

    // 子组件拿到的是**完整的宿主 props**（t / 196 个 hook / 动作）再叠加本层的
    // 额外字段：插槽里的子组件和顶层组件是同一类东西，它们也 `{ t, useXxx }`。
    // 只传 extraProps 会让子组件第一句就 `t is not a function`。
    const base = { ...(hostProps ?? {}), ...extraProps };
    // 防自递归：路径里已经出现过同名插槽就停手。上游靠 entry 的 children
    // 声明表做所有权校验（SlotOwnershipError），我们只有平坦名字表。
    const path = Array.isArray(extraProps?.__slotPath) ? extraProps.__slotPath : [];
    const depth = Number(extraProps?.__slotDepth ?? 0);
    if (path.includes(name) || depth >= MAX_DEPTH) return null;

    return picked.map((entry, i) => {
      const Component = entry?.Component ?? entry?.component ?? null;
      if (typeof Component !== 'function' && typeof Component !== 'object') return null;
      return React.createElement(Component, {
        key: `${name}#${i}`,
        ...base,
        slot: name,
        meta: entry?.meta ?? null,
        __slotDepth: depth + 1,
        __slotPath: [...path, name],
      });
    }).filter(Boolean);
  };

  // ── 组装 ────────────────────────────────────────────────────────────────
  // 普通对象 + Object.defineProperties：展开（{...props}）能带走每一个键。
  // renderSlot 在上面就引用了 hostProps（`let` + 后面赋值）：插槽是在渲染期
  // 才被调用，那时它已经装好了。
  let hostProps = null;
  const props = {};
  hostProps = props;

  const define = (name, value) => {
    Object.defineProperty(props, name, {
      value, enumerable: true, configurable: true, writable: true,
    });
  };

  for (const name of HOOK_NAMES) {
    define(name, hookFor(name, defaultFor(name)));
  }

  // 插件里 `const { t } = props` 与 `useLocale()` 两种写法都要能取到文案，
  // 所以 t 同时是 props.t 和 useLocale 返回值上的 .t。
  define('t', t);
  define('renderSlot', renderSlot);
  define('translate', t);
  define('locale', localeService?.getSnapshot?.() ?? { locale: 'zh', active: 'zh' });
  define('slots', slots);
  define('ctx', ctx);
  define('services', services);

  // 动作类：`onClose` / `install` / `refresh` 这些先给可调用空实现。
  // 放在 hook 之后，避免和真实的 `useXxx` 名字撞车。
  for (const name of ACTION_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(props, name)) define(name, noop);
  }

  for (const [k, v] of Object.entries(extra)) define(k, v);

  // `__ctx` 是历史包袱：prerender / 回归脚本按这个名字传 ctx，继续带上。
  if (ctx && !Object.prototype.hasOwnProperty.call(props, '__ctx')) define('__ctx', ctx);

  return props;
}

/**
 * 常用的动作名（从 60 个插件的 props 解构里出现过的）。
 *
 * 这些不是 hook，所以不进 HOOK_NAMES；但它们同样是"组件以为宿主会给"的东西，
 * 缺了就是 `install is not a function`。真正的实现在运行时那一轮。
 */
export const ACTION_NAMES = Object.freeze([
  'install', 'uninstall', 'ensure', 'openPackage', 'refresh', 'reload', 'retry',
  'onClose', 'onOpen', 'onSelect', 'onChange', 'onSubmit', 'onCancel', 'onConfirm',
  'onDismiss', 'onToggle', 'onCopy', 'onInstall', 'onRemove', 'onRetry', 'onClick',
  'onNavigate', 'onBack', 'onRestore', 'open', 'close', 'toggle',
]);

/** 诊断：这一份 props 里哪些 hook 是"空态"（值为 undefined）。下一轮按这个清单补。 */
export function emptyHooks(props) {
  return HOOK_NAMES.filter((name) => typeof props?.[name] === 'function' && props[name]() === undefined);
}

export default { createSlotProps, HOOK_NAMES, ACTION_NAMES, defaultFor, emptyHooks };
