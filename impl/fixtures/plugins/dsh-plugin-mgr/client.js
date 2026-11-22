(function() {

//#region src/client/runtime.ts
	let injectedReact = null;
	let injectedRequire = null;
	/** 入口在 factory 内注入宿主提供的 React 实例。 */
	function provideReact(react) {
		injectedReact = react;
	}
	/** 入口在 factory 内注入宿主提供的 require，用于按需解析宿主模块。 */
	function provideRequire(requireFn) {
		injectedRequire = requireFn;
	}
	/** 取用注入的 React。必须在 provideReact 之后（即任意渲染发生前）调用。 */
	function getReact() {
		if (!injectedReact) throw new Error("[dsh-plugin-mgr] React 尚未注入：entry 需先调用 provideReact()");
		return injectedReact;
	}
	/** 取用注入的 require，用于按需解析宿主模块（如 dsh-client-ui-primitives）。 */
	function getRequire() {
		if (!injectedRequire) throw new Error("[dsh-plugin-mgr] require 尚未注入：entry 需先调用 provideRequire()");
		return injectedRequire;
	}
	/**
	* 宿主注入的值是否可以直接作为 React 组件渲染。
	* 组件可能是函数，也可能是 forwardRef / memo 包装出的带 $$typeof 的对象
	* （宿主 0.2.0 起 Button 即 forwardRef）；宿主坏 shim 给出的字符串等一律不算。
	*/
	function isRenderableComponent(value) {
		if (typeof value === "function") return true;
		return value !== null && typeof value === "object" && "$$typeof" in value;
	}

//#endregion
//#region src/client/i18n.ts
	const NS = "dsh-plugin-mgr";
	const zh = {
		tab: "插件管理",
		meta: "profile：{0} ｜ 共 {1} 个插件",
		refresh: "刷新",
		refreshing: "刷新中…",
		refreshedAt: "列表已刷新 · {0}",
		col1: "单列显示",
		col2: "双列显示",
		layoutGroup: "列表布局",
		searchPlaceholder: "搜索插件",
		searchAria: "搜索插件",
		searchClear: "清除搜索内容",
		toastClose: "关闭",
		toastExpand: "点击展开全文",
		toastCollapse: "点击收起",
		metaFiltered: "profile：{0} ｜ {1} / {2} 个插件",
		emptyFiltered: "没有匹配的插件。",
		clearFilters: "清除搜索",
		stateOn: "运行中",
		stateOff: "已停止",
		stateError: "加载失败",
		errorField: "错误信息",
		toggleOn: "点击停用（HMR 约 1s 生效）",
		toggleOff: "点击启用（HMR 约 1s 生效）",
		selfHint: "本插件",
		protectedToggle: "宿主基础设施，不允许启停",
		clientOnlyToggle: "纯 client 插件，无补丁行可控制",
		switchAria: "{0} 启用状态",
		collapse: "收起详情",
		expand: "展开详情",
		version: "版本",
		source: "安装来源",
		sourceNpm: "npm",
		sourceGithub: "GitHub",
		sourceLocal: "本地",
		description: "插件介绍",
		noDescription: "（未提供介绍）",
		uninstall: "卸载",
		uninstalling: "卸载中…",
		uninstallTitle: "从 profile 移除该插件包",
		protectedUninstall: "受保护的宿主模块",
		updateAvailable: "可更新",
		latestVersion: "最新版本",
		latestVersionTitle: "最新版本 v{0}",
		publishedAt: "发布于 {0}",
		update: "更新",
		updating: "更新中…",
		updateTitle: "更新到最新版本（npm registry）",
		confirmUpdate: "确定更新 {0} 到 v{1}？",
		confirmUpdateSelf: "注意：这是插件管理器自己，更新期间本页面可能短暂失效。",
		updatedMsg: "{0} 已更新到 v{1}",
		updateFail: "{0} 更新失败：{1}",
		updateSkipped: "{0} 仍为 v{1}：pnpm 供应链策略（minimumReleaseAge）可能静默跳过了发布过新的版本——稍后重试，或先装精确版本",
		empty: "该 profile 尚未安装任何插件。",
		loading: "加载中...",
		loadError: "读取已安装插件失败：",
		retry: "重试",
		disabledMsg: "{0} 已停止，约 1s 内生效（HMR）",
		enabledMsg: "{0} 已启动，约 1s 内生效（HMR）",
		toggleFail: "{0} 切换失败：{1}",
		uninstalledMsg: "{0} 已卸载",
		uninstallFail: "{0} 卸载失败：{1}",
		confirmUninstall: "确定卸载 {0}@{1}？",
		confirmUninstallNoVer: "确定卸载 {0}？",
		confirmSelf: "注意：这是插件管理器自己，卸载后本页面将消失。",
		cancel: "取消"
	};
	const en = {
		tab: "Plugin Manager",
		meta: "profile: {0} ｜ {1} plugin(s)",
		refresh: "Refresh",
		refreshing: "Refreshing…",
		refreshedAt: "Refreshed · {0}",
		col1: "Single column",
		col2: "Two columns",
		layoutGroup: "List layout",
		searchPlaceholder: "Search plugins",
		searchAria: "Search plugins",
		searchClear: "Clear search",
		toastClose: "Close",
		toastExpand: "Click to expand",
		toastCollapse: "Click to collapse",
		metaFiltered: "profile: {0} ｜ {1} / {2} plugin(s)",
		emptyFiltered: "No matching plugins.",
		clearFilters: "Clear search",
		stateOn: "Running",
		stateOff: "Stopped",
		stateError: "Load failed",
		errorField: "Error",
		toggleOn: "Click to disable (HMR ~1s)",
		toggleOff: "Click to enable (HMR ~1s)",
		selfHint: "This plugin",
		protectedToggle: "Host infrastructure, cannot be toggled",
		clientOnlyToggle: "Client-only plugin, no patch rows to control",
		switchAria: "{0} enabled state",
		collapse: "Collapse details",
		expand: "Expand details",
		version: "Version",
		source: "Source",
		sourceNpm: "npm",
		sourceGithub: "GitHub",
		sourceLocal: "Local",
		description: "Description",
		noDescription: "(no description)",
		uninstall: "Uninstall",
		uninstalling: "Uninstalling…",
		uninstallTitle: "Remove this package from the profile",
		protectedUninstall: "Protected host module",
		updateAvailable: "Update",
		latestVersion: "Latest",
		latestVersionTitle: "Latest version v{0}",
		publishedAt: "Published {0}",
		update: "Update",
		updating: "Updating…",
		updateTitle: "Update to the latest version (npm registry)",
		confirmUpdate: "Update {0} to v{1}?",
		confirmUpdateSelf: "Note: this is the plugin manager itself; this page may briefly go down during the update.",
		updatedMsg: "{0} updated to v{1}",
		updateFail: "Failed to update {0}: {1}",
		updateSkipped: "{0} is still v{1}: the pnpm supply-chain policy (minimumReleaseAge) may have silently skipped a too-fresh release — retry later, or install an exact version first",
		empty: "No plugins installed in this profile.",
		loading: "Loading...",
		loadError: "Failed to load installed plugins: ",
		retry: "Retry",
		disabledMsg: "{0} disabled, takes effect in ~1s (HMR)",
		enabledMsg: "{0} enabled, takes effect in ~1s (HMR)",
		toggleFail: "Failed to toggle {0}: {1}",
		uninstalledMsg: "{0} uninstalled",
		uninstallFail: "Failed to uninstall {0}: {1}",
		confirmUninstall: "Uninstall {0}@{1}?",
		confirmUninstallNoVer: "Uninstall {0}?",
		confirmSelf: "Note: this is the plugin manager itself; this page will disappear after uninstalling.",
		cancel: "Cancel"
	};
	/** {0}/{1} 占位替换 */
	function fmt(s, ...args) {
		return args.reduce((acc, v, i) => acc.replace(`{${i}}`, String(v)), s);
	}

//#endregion
//#region src/client/styles.ts
	const CSS = `
/* 布局：根容器限高（JS 按宿主滚动容器计算），只有列表区滚动。
   不用 sticky —— 所有元素保持透明，直接复用宿主主题背景，深浅色天然一致 */
.dshpm-root { display:flex; flex-direction:column; gap:12px; color:var(--dsw-alias-label-primary,#333); overflow:hidden; }
.dshpm-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; flex:none; }
/* 列表滚动区：占满剩余高度，内部滚动；overscroll 防止滚到底带动外层页面 */
.dshpm-list-area { flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; }
.dshpm-meta { font-size:13px; color:var(--dsw-alias-label-tertiary,#888); margin-right:auto; }
.dshpm-seg { display:inline-flex; border:1px solid var(--dsw-alias-border-l2,#ddd); border-radius:8px; overflow:hidden; }
.dshpm-seg-btn { border:none; background:transparent; padding:4px 10px; font-size:12px; line-height:18px; cursor:pointer; color:var(--dsw-alias-label-tertiary,#888); transition:color .16s,background .16s; display:inline-flex; align-items:center; justify-content:center; }
.dshpm-seg-btn:hover { color:var(--dsw-alias-label-primary,#333); }
.dshpm-seg-btn.is-active { background:var(--dsw-alias-button-primary-fill,#4f46e5); color:var(--dsw-alias-label-primary-foreground,#fff); }
.dshpm-seg-btn svg { width:14px; height:14px; display:block; }
/* 可折叠搜索框：默认 28px 圆形图标按钮，点击后容器向左滑开到 190px。
   展开态最左是搜索图标（input 让出 padding-left），有内容时右侧出现清除按钮 */
.dshpm-search { flex:none; }
.dshpm-search-box { position:relative; display:flex; align-items:center; box-sizing:border-box; width:28px; height:28px; border:1px solid transparent; border-radius:999px; background:transparent; overflow:hidden; transition:width .25s ease,border-color .16s,background .16s,box-shadow .16s; }
.dshpm-search.is-open .dshpm-search-box { width:190px; border-color:var(--dsw-alias-border-l2,#ddd); background:var(--dsw-alias-bg-layer-1,#f5f5f5); }
.dshpm-search.is-open .dshpm-search-box:focus-within { border-color:var(--dsw-alias-state-business-primary,#1967d2); box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary,#1967d2) 18%, transparent); }
.dshpm-search-box input[type="text"] { box-sizing:border-box; width:100%; min-width:0; border:none; outline:none; background:transparent; color:var(--dsw-alias-label-primary,#333); font-size:12px; line-height:18px; padding:0 24px 0 30px; opacity:0; pointer-events:none; transition:opacity .18s ease; }
.dshpm-search.is-open .dshpm-search-box input[type="text"] { opacity:1; pointer-events:auto; }
.dshpm-search-box input[type="text"]::placeholder { color:var(--dsw-alias-label-tertiary,#888); }
/* 左侧搜索图标：折叠态即整个控件（可点展开），展开态点击=聚焦输入框 */
.dshpm-search-icon { position:absolute; left:0; top:0; width:26px; height:26px; display:flex; align-items:center; justify-content:center; border:none; background:transparent; padding:0; cursor:pointer; color:var(--dsw-alias-label-tertiary,#888); transition:color .16s; flex:none; }
.dshpm-search-icon:hover { color:var(--dsw-alias-label-primary,#333); }
.dshpm-search-icon svg { width:15px; height:15px; display:block; }
/* 右侧清除按钮：仅展开且有内容时渲染 */
.dshpm-search-clear { position:absolute; right:4px; width:20px; height:20px; display:flex; align-items:center; justify-content:center; border:none; border-radius:50%; background:transparent; padding:0; cursor:pointer; color:var(--dsw-alias-label-tertiary,#888); transition:color .16s,background .16s; flex:none; }
.dshpm-search-clear:hover { color:var(--dsw-alias-label-primary,#333); background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06)); }
.dshpm-search-clear svg { width:12px; height:12px; display:block; }
/* 两按钮之间的分隔竖线。span 默认 inline、width 不生效，必须显式 block；
   1px 在部分渲染下过细，用 2px + label-dimmed 保证可见 */
.dshpm-seg-divider { display:block; width:2px; align-self:stretch; background:var(--dsw-alias-label-dimmed,#999); }
.dshpm-list { display:grid; grid-template-columns:minmax(0,1fr); align-items:start; gap:10px; list-style:none; margin:0; padding:0; }
.dshpm-root.is-cols-2 .dshpm-list { grid-template-columns:repeat(2, minmax(0,1fr)); }
/* 单列时横条更扁：收紧行距 + 缩小图标 */
.dshpm-root:not(.is-cols-2) .dshpm-row { padding:7px 16px; }
.dshpm-root:not(.is-cols-2) .dshpm-icon { width:28px; height:28px; border-radius:8px; }
.dshpm-root:not(.is-cols-2) .dshpm-icon svg { width:15px; height:15px; }
/* 双列下卡片更紧凑：隐藏状态文字（switch 已表达状态）和插件图标，给名称留足空间 */
.dshpm-root.is-cols-2 .dshpm-state { display:none; }
.dshpm-root.is-cols-2 .dshpm-icon { display:none; }
.dshpm-root.is-cols-2 .dshpm-row { padding:10px 14px; gap:10px; }
.dshpm-root.is-cols-2 .dshpm-detail { padding:8px 14px 12px 14px; }
.dshpm-card { display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l2,#e2e2e2); background:var(--dsw-alias-bg-layer-3,#fff); border-radius:12px; transition:border-color .16s,background .16s; }
.dshpm-card:hover { border-color:var(--dsw-alias-label-dimmed,#999); }
.dshpm-card.is-open { background:var(--dsw-alias-bg-layer-2,#fafafa); border-color:var(--dsw-alias-label-dimmed,#999); }
.dshpm-row { display:flex; align-items:center; gap:12px; padding:12px 16px; cursor:pointer; user-select:none; min-width:0; }
.dshpm-arrow { flex:none; width:20px; height:20px; display:flex; align-items:center; justify-content:center; cursor:pointer; border:none; background:transparent; padding:0; font:inherit; color:var(--dsw-alias-label-tertiary,#888); transition:transform .16s,color .16s; }
.dshpm-arrow:hover { color:var(--dsw-alias-label-primary,#333); }
.dshpm-arrow.is-open { transform:rotate(180deg); }
.dshpm-arrow svg { width:14px; height:14px; display:block; }
/* 键盘可达性：switch 与展开按钮获得焦点时显示焦点环 */
.dshpm-switch:focus-visible, .dshpm-arrow:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,#1967d2); outline-offset:2px; }
.dshpm-icon { width:36px; height:36px; border-radius:10px; flex:none; display:flex; align-items:center; justify-content:center; color:var(--dsw-alias-label-secondary,#555); transition:opacity .16s; }
.dshpm-icon svg { width:18px; height:18px; display:block; }
.dshpm-card.is-off .dshpm-icon { opacity:.5; }
.dshpm-name { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary,#333); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dshpm-card.is-off .dshpm-name { color:var(--dsw-alias-label-tertiary,#888); }
.dshpm-actions { margin-left:auto; display:flex; align-items:center; gap:12px; flex:none; }
.dshpm-state { font-size:11px; line-height:17px; white-space:nowrap; color:var(--dsw-alias-label-tertiary,#888); }
.dshpm-state.is-on { color:var(--dsw-alias-state-success-primary,#1e8e3e); }
.dshpm-state.is-err { color:var(--dsw-alias-state-error-primary,#d32f2f); font-weight:600; }
/* 小圆角标签：来源分类（中性）与「可更新」徽标（信息蓝）共用底样式 */
.dshpm-pill { display:inline-flex; align-items:center; padding:0 8px; border:1px solid var(--dsw-alias-border-l2,#ddd); border-radius:999px; font-size:11px; line-height:17px; white-space:nowrap; color:var(--dsw-alias-label-tertiary,#888); }
.dshpm-pill.is-update { color:var(--dsw-alias-state-info-primary,#1967d2); border-color:var(--dsw-alias-state-info-primary,#1967d2); }
/* 最新版本行里跟在版本号后的发布时间（弱化色，非等宽） */
.dshpm-published { color:var(--dsw-alias-label-tertiary,#888); font-family:inherit; font-weight:400; }
.dshpm-switch { display:inline-block; box-sizing:border-box; width:36px; height:20px; border-radius:10px; padding:2px; cursor:pointer; background:var(--dsw-alias-label-tertiary,#888); transition:background .16s; flex:none; }
.dshpm-switch.is-on { background:var(--dsw-alias-state-success-primary,#1e8e3e); }
.dshpm-switch.is-busy { opacity:.5; cursor:wait; }
.dshpm-switch.is-frozen { opacity:.4; cursor:not-allowed; }
.dshpm-knob { display:block; width:16px; height:16px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.2); transition:transform .16s; }
.dshpm-switch.is-on .dshpm-knob { transform:translateX(16px); }
.dshpm-detail { border-top:1px solid var(--dsw-alias-border-l2,#eee); padding:10px 16px 14px 48px; display:flex; flex-direction:column; gap:4px; }
.dshpm-field { display:flex; gap:10px; font-size:12px; line-height:1.6; }
.dshpm-field-key { flex:none; width:60px; color:var(--dsw-alias-label-tertiary,#888); }
.dshpm-field-val { color:var(--dsw-alias-label-primary,#333); word-break:break-all; min-width:0; }
.dshpm-field-val.is-code { font-family:var(--ds-font-family-code,monospace); }
.dshpm-repo-link { color:var(--dsw-alias-state-info-primary,#1967d2); text-decoration:none; font-size:12px; word-break:break-all; }
.dshpm-repo-link:hover { text-decoration:underline; }
.dshpm-detail-actions { display:flex; justify-content:flex-end; align-items:center; gap:16px; margin-top:8px; }
.dshpm-btn { border-radius:8px; padding:5px 14px; font-size:13px; line-height:1.5; cursor:pointer; border:1px solid var(--dsw-alias-border-l2,#ddd); color:var(--dsw-alias-label-secondary,#555); background:transparent; white-space:nowrap; transition:color .16s,border-color .16s,background .16s; }
.dshpm-btn:hover:not(:disabled) { color:var(--dsw-alias-label-primary,#333); border-color:var(--dsw-alias-label-dimmed,#999); }
.dshpm-btn:disabled { opacity:.5; cursor:not-allowed; }
.dshpm-btn-danger { color:var(--dsw-alias-state-error-primary,#d32f2f); border-color:var(--dsw-alias-state-error-primary,#d32f2f); }
.dshpm-btn-danger:hover:not(:disabled) { color:var(--dsw-alias-state-error-primary,#d32f2f); border-color:var(--dsw-alias-state-error-primary,#d32f2f); background:var(--dsw-alias-state-error-bg,#fce8e6); }
/* 更新按钮：信息蓝（与「可更新」徽标同色系），与右侧卸载按钮拉开间距 */
.dshpm-btn-update { color:var(--dsw-alias-state-info-primary,#1967d2); border-color:var(--dsw-alias-state-info-primary,#1967d2); }
.dshpm-btn-update:hover:not(:disabled) { color:var(--dsw-alias-state-info-primary,#1967d2); border-color:var(--dsw-alias-state-info-primary,#1967d2); background:var(--dsw-alias-state-info-bg,#e8f0fe); }
.dshpm-banner { font-size:12px; line-height:1.6; padding:8px 12px; border-radius:8px; word-break:break-all; }
.dshpm-banner-ok { background:var(--dsw-alias-state-success-bg,#e6f4ea); color:var(--dsw-alias-state-success-primary,#1e8e3e); }
.dshpm-banner-err { background:var(--dsw-alias-state-error-bg,#fce8e6); color:var(--dsw-alias-state-error-primary,#d32f2f); white-space:pre-wrap; }
/* Toast 通知容器：固定在视口正中央，不随页面滚动 */
.dshpm-toast-container { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:10000; display:flex; flex-direction:column-reverse; gap:8px; pointer-events:none; align-items:center; max-height:80vh; }
.dshpm-toast { pointer-events:auto; box-sizing:border-box; font-size:13px; line-height:1.5; padding:10px 16px; border-radius:10px; box-shadow:0 4px 12px rgba(0,0,0,.15); word-break:break-all; max-width:360px; max-height:60vh; overflow:hidden; animation:dshpm-toast-in .3s ease-out; transition:opacity .3s,transform .3s; }
.dshpm-toast.is-leaving { opacity:0; transform:translateY(10px); }
.dshpm-toast-ok { background:var(--dsw-alias-state-success-bg,#e6f4ea); color:var(--dsw-alias-state-success-primary,#1e8e3e); border:1px solid var(--dsw-alias-state-success-primary,#1e8e3e); white-space:pre-wrap; }
.dshpm-toast-err { background:var(--dsw-alias-state-error-bg,#fce8e6); color:var(--dsw-alias-state-error-primary,#d32f2f); border:1px solid var(--dsw-alias-state-error-primary,#d32f2f); white-space:pre-wrap; display:flex; align-items:flex-start; gap:12px; }
/* 错误文本：默认最多 6 行缩略（点击展开全文），防止超长信息撑爆居中容器 */
.dshpm-toast-text { min-width:0; flex:1 1 auto; cursor:default; }
.dshpm-toast-text.is-clamped { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:6; overflow:hidden; cursor:pointer; }
.dshpm-toast-close { flex:none; width:18px; height:18px; display:flex; align-items:center; justify-content:center; cursor:pointer; opacity:.6; transition:opacity .16s; border:none; background:transparent; padding:0; color:inherit; }
.dshpm-toast-close:hover { opacity:1; }
.dshpm-toast-close svg { width:14px; height:14px; display:block; }
@keyframes dshpm-toast-in { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
.dshpm-empty { padding:40px 16px; text-align:center; color:var(--dsw-alias-label-tertiary,#999); border:1px dashed var(--dsw-alias-border-l2,#e2e2e2); border-radius:12px; font-size:13px; }
.dshpm-loading { padding:32px 0; text-align:center; color:var(--dsw-alias-label-tertiary,#999); font-size:13px; }
.dshpm-hint { font-size:12px; color:var(--dsw-alias-label-tertiary,#888); }
`;
	/** 往 <head> 注入样式表（幂等）。 */
	function ensureCss() {
		const id = "dsh-plugin-mgr-style";
		if (document.getElementById(id)) return;
		const el = document.createElement("style");
		el.id = id;
		el.textContent = CSS;
		document.head.appendChild(el);
	}

//#endregion
//#region src/shared/api-paths.ts
	const API_BASE = "/api/plugin-manager";
	const API = {
		/** GET：列出 profile 已安装插件 + 启停状态 */
		list: `${API_BASE}/list`,
		/** POST { name, disable }：启用/停用一个插件 */
		toggle: `${API_BASE}/toggle`,
		/** POST { name, selfConfirm? }：卸载插件 */
		uninstall: `${API_BASE}/uninstall`,
		/** GET：npm 来源插件的可更新信息 */
		updates: `${API_BASE}/updates`,
		/** POST { name, selfConfirm? }：更新到 latest */
		update: `${API_BASE}/update`
	};

//#endregion
//#region src/client/api.ts
/** GET 并解析 JSON；不校验 ok 字段（调用方按需处理）。 */
	async function get(path) {
		return (await fetch(path, { cache: "no-store" })).json();
	}
	/** POST JSON 并解析响应；ok=false 时抛错（错误信息取服务端 error）。 */
	async function post(path, body) {
		const resp = await fetch(path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			cache: "no-store"
		});
		const json = await resp.json().catch(() => ({
			ok: false,
			error: `HTTP ${resp.status}`
		}));
		if (!json.ok) throw new Error(json.error || `HTTP ${resp.status}`);
		return json;
	}

//#endregion
//#region src/client/toast.tsx
/** Toast 队列状态与操作。 */
	function useToasts() {
		const { useState, useCallback, useRef } = getReact();
		const [toasts, setToasts] = useState([]);
		const idRef = useRef(0);
		return {
			toasts,
			addToast: useCallback((type, text) => {
				const id = ++idRef.current;
				setToasts((prev) => [...prev, {
					id,
					type,
					text,
					leaving: false
				}]);
				if (type === "ok") {
					setTimeout(() => {
						setToasts((prev) => prev.map((t) => t.id === id ? {
							...t,
							leaving: true
						} : t));
					}, 3500);
					setTimeout(() => {
						setToasts((prev) => prev.filter((t) => t.id !== id));
					}, 4e3);
				}
			}, []),
			dismissToast: useCallback((id) => {
				setToasts((prev) => prev.map((t) => t.id === id ? {
					...t,
					leaving: true
				} : t));
				setTimeout(() => {
					setToasts((prev) => prev.filter((t) => t.id !== id));
				}, 300);
			}, [])
		};
	}
	/**
	* Toast 容器渲染（挂在组件树末尾即可）。
	* 错误通知文本超长时默认缩略（6 行），点击切换展开/收起——
	* 否则超长信息会把居中定位的容器撑出视口，关闭按钮点不到。
	*/
	function ToastHost({ toasts, onDismiss, t }) {
		const React = getReact();
		const { useState } = React;
		const [expandedIds, setExpandedIds] = useState(() => /* @__PURE__ */ new Set());
		const toggleExpand = (id) => {
			setExpandedIds((prev) => {
				const next = new Set(prev);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				return next;
			});
		};
		if (toasts.length === 0) return null;
		return /* @__PURE__ */ React.createElement("div", {
			className: "dshpm-toast-container",
			"aria-live": "polite"
		}, toasts.map((toast) => {
			const isError = toast.type === "error";
			const expanded = expandedIds.has(toast.id);
			const clamped = isError && !expanded;
			return /* @__PURE__ */ React.createElement("div", {
				key: toast.id,
				className: `dshpm-toast ${isError ? "dshpm-toast-err" : "dshpm-toast-ok"}${toast.leaving ? " is-leaving" : ""}`,
				role: "alert"
			}, /* @__PURE__ */ React.createElement("span", {
				className: `dshpm-toast-text${clamped ? " is-clamped" : ""}`,
				onClick: isError ? () => toggleExpand(toast.id) : void 0,
				title: isError ? clamped ? t?.("toastExpand") : t?.("toastCollapse") : void 0
			}, toast.text), isError && /* @__PURE__ */ React.createElement("button", {
				className: "dshpm-toast-close",
				"aria-label": t?.("toastClose") ?? "关闭",
				title: t?.("toastClose") ?? "关闭",
				onClick: () => onDismiss(toast.id)
			}, /* @__PURE__ */ React.createElement("svg", {
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}, /* @__PURE__ */ React.createElement("path", { d: "M18 6L6 18M6 6l12 12" }))));
		}));
	}

//#endregion
//#region src/client/components/Toolbar.tsx
	function MagnifierIcon() {
		const React = getReact();
		return /* @__PURE__ */ React.createElement("svg", {
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true"
		}, /* @__PURE__ */ React.createElement("circle", {
			cx: "11",
			cy: "11",
			r: "7"
		}), /* @__PURE__ */ React.createElement("path", { d: "M21 21l-4.35-4.35" }));
	}
	function CollapsibleSearch({ t, query, onQueryChange }) {
		const React = getReact();
		const { useState, useEffect, useRef } = React;
		const [open, setOpen] = useState(false);
		const inputRef = useRef(null);
		const collapseTimerRef = useRef(null);
		const clearCollapseTimer = () => {
			if (collapseTimerRef.current !== null) {
				clearTimeout(collapseTimerRef.current);
				collapseTimerRef.current = null;
			}
		};
		useEffect(() => {
			if (open) inputRef.current?.focus();
		}, [open]);
		useEffect(() => clearCollapseTimer, []);
		const expand = () => {
			clearCollapseTimer();
			setOpen(true);
		};
		const handleBlur = () => {
			clearCollapseTimer();
			if (query !== "") return;
			collapseTimerRef.current = setTimeout(() => setOpen(false), 3e3);
		};
		const clearQuery = () => {
			onQueryChange("");
			inputRef.current?.focus();
		};
		return /* @__PURE__ */ React.createElement("div", { className: `dshpm-search${open ? " is-open" : ""}` }, /* @__PURE__ */ React.createElement("div", { className: "dshpm-search-box" }, /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "dshpm-search-icon",
			title: t("searchAria"),
			"aria-label": t("searchAria"),
			tabIndex: open ? -1 : 0,
			onClick: () => open ? inputRef.current?.focus() : expand()
		}, /* @__PURE__ */ React.createElement(MagnifierIcon, null)), /* @__PURE__ */ React.createElement("input", {
			ref: inputRef,
			type: "text",
			value: query,
			placeholder: t("searchPlaceholder"),
			"aria-label": t("searchAria"),
			tabIndex: open ? 0 : -1,
			onChange: (e) => onQueryChange(e.target.value),
			onFocus: clearCollapseTimer,
			onBlur: handleBlur
		}), open && query !== "" && /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: "dshpm-search-clear",
			title: t("searchClear"),
			"aria-label": t("searchClear"),
			onClick: clearQuery
		}, /* @__PURE__ */ React.createElement("svg", {
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			"aria-hidden": "true"
		}, /* @__PURE__ */ React.createElement("path", { d: "M18 6L6 18M6 6l12 12" })))));
	}
	function Toolbar(props) {
		const React = getReact();
		const { t, profile, total, visibleCount, hasFilter, query, onQueryChange, columns, onColumnsChange, refreshing, onRefresh } = props;
		return /* @__PURE__ */ React.createElement("div", { className: "dshpm-toolbar" }, /* @__PURE__ */ React.createElement("span", { className: "dshpm-meta" }, hasFilter ? fmt(t("metaFiltered"), profile, visibleCount, total) : fmt(t("meta"), profile, total)), /* @__PURE__ */ React.createElement(CollapsibleSearch, {
			t,
			query,
			onQueryChange
		}), /* @__PURE__ */ React.createElement("div", {
			className: "dshpm-seg",
			role: "group",
			"aria-label": t("layoutGroup")
		}, /* @__PURE__ */ React.createElement("button", {
			className: `dshpm-seg-btn${columns === 1 ? " is-active" : ""}`,
			title: t("col1"),
			"aria-label": t("col1"),
			"aria-pressed": columns === 1 ? "true" : "false",
			onClick: () => onColumnsChange(1)
		}, /* @__PURE__ */ React.createElement("svg", {
			viewBox: "0 0 24 24",
			fill: "currentColor"
		}, /* @__PURE__ */ React.createElement("rect", {
			x: "9",
			y: "4",
			width: "6",
			height: "16",
			rx: "1.5"
		}))), /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-seg-divider",
			"aria-hidden": "true"
		}), /* @__PURE__ */ React.createElement("button", {
			className: `dshpm-seg-btn${columns === 2 ? " is-active" : ""}`,
			title: t("col2"),
			"aria-label": t("col2"),
			"aria-pressed": columns === 2 ? "true" : "false",
			onClick: () => onColumnsChange(2)
		}, /* @__PURE__ */ React.createElement("svg", {
			viewBox: "0 0 24 24",
			fill: "currentColor"
		}, /* @__PURE__ */ React.createElement("rect", {
			x: "4",
			y: "4",
			width: "6.5",
			height: "16",
			rx: "1.5"
		}), /* @__PURE__ */ React.createElement("rect", {
			x: "13.5",
			y: "4",
			width: "6.5",
			height: "16",
			rx: "1.5"
		})))), /* @__PURE__ */ React.createElement("button", {
			className: "dshpm-btn",
			disabled: refreshing,
			onClick: onRefresh
		}, refreshing ? t("refreshing") : t("refresh")));
	}

//#endregion
//#region src/client/components/PluginCard.tsx
	function PluginCard(props) {
		const { t, row, upd, pending: p, open, onToggleExpand, onToggle, onBeginUpdate, onBeginUninstall } = props;
		const React = getReact();
		const busy = p === "toggle" || p === "uninstall" || p === "update";
		const canUpdate = !!upd && !!upd.update && !row.protected;
		const publishedText = upd && upd.publishedAt && !isNaN(Date.parse(upd.publishedAt)) ? new Date(upd.publishedAt).toLocaleString() : null;
		const displayName = row.name.replace(/^@[^/]+\//u, "");
		const canToggle = !row.protected && row.rows.length > 0 && !row.self;
		const on = !row.disabled;
		const switchCls = [
			"dshpm-switch",
			on ? "is-on" : "",
			canToggle ? busy ? "is-busy" : "" : "is-frozen"
		].filter(Boolean).join(" ");
		const switchTitle = !canToggle ? row.self ? t("selfHint") : row.protected ? t("protectedToggle") : t("clientOnlyToggle") : on ? t("toggleOn") : t("toggleOff");
		return /* @__PURE__ */ React.createElement("li", { className: `dshpm-card${on ? "" : " is-off"}${open ? " is-open" : ""}` }, /* @__PURE__ */ React.createElement("div", {
			className: "dshpm-row",
			onClick: onToggleExpand
		}, /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-icon",
			"aria-hidden": "true"
		}, /* @__PURE__ */ React.createElement("svg", {
			viewBox: "0 0 24 24",
			fill: "currentColor"
		}, /* @__PURE__ */ React.createElement("path", { d: "M10.5 3a2.5 2.5 0 0 1 2.5 2.5v1h3.5A1.5 1.5 0 0 1 18 8v3.5h1a2.5 2.5 0 0 1 0 5h-1V20a1.5 1.5 0 0 1-1.5 1.5H13v-1a2.5 2.5 0 0 0-5 0v1H4.5A1.5 1.5 0 0 1 3 20v-3.6h1a2.4 2.4 0 0 0 0-4.8H3V8a1.5 1.5 0 0 1 1.5-1.5H8v-1A2.5 2.5 0 0 1 10.5 3Z" }))), /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-name",
			title: row.name
		}, displayName), /* @__PURE__ */ React.createElement("div", { className: "dshpm-actions" }, canUpdate && /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-pill is-update",
			title: fmt(t("latestVersionTitle"), upd.latest) + (publishedText ? ` · ${fmt(t("publishedAt"), publishedText)}` : "")
		}, t("updateAvailable")), /* @__PURE__ */ React.createElement("span", { className: `dshpm-state${row.error ? " is-err" : ""}${on && !row.error ? " is-on" : ""}` }, row.error ? t("stateError") : on ? t("stateOn") : t("stateOff")), /* @__PURE__ */ React.createElement("span", {
			role: "switch",
			"aria-checked": on ? "true" : "false",
			"aria-label": fmt(t("switchAria"), row.name),
			"aria-disabled": !canToggle || busy,
			tabIndex: canToggle ? 0 : -1,
			className: switchCls,
			title: switchTitle,
			onClick: (e) => {
				e.stopPropagation();
				if (canToggle && !busy) onToggle();
			},
			onKeyDown: (e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault();
				e.stopPropagation();
				if (canToggle && !busy) onToggle();
			}
		}, /* @__PURE__ */ React.createElement("span", { className: "dshpm-knob" })), /* @__PURE__ */ React.createElement("button", {
			type: "button",
			className: `dshpm-arrow${open ? " is-open" : ""}`,
			"aria-label": open ? t("collapse") : t("expand"),
			"aria-expanded": open ? "true" : "false",
			onClick: (e) => {
				e.stopPropagation();
				onToggleExpand();
			}
		}, /* @__PURE__ */ React.createElement("svg", {
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		}, /* @__PURE__ */ React.createElement("path", { d: "M6 9l6 6 6-6" }))))), open ? /* @__PURE__ */ React.createElement("div", { className: "dshpm-detail" }, /* @__PURE__ */ React.createElement("div", { className: "dshpm-field" }, /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-key" }, t("version")), /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-val" }, row.version === "-" ? row.version : `v${row.version}`)), row.error ? /* @__PURE__ */ React.createElement("div", { className: "dshpm-field" }, /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-key" }, t("errorField")), /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-field-val",
			style: {
				color: "var(--dsw-alias-state-error-primary,#d32f2f)",
				whiteSpace: "pre-wrap"
			}
		}, row.error)) : null, canUpdate && /* @__PURE__ */ React.createElement("div", { className: "dshpm-field" }, /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-key" }, t("latestVersion")), /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-field-val is-code",
			style: { color: "var(--dsw-alias-state-info-primary,#1967d2)" }
		}, `v${upd.latest}`, publishedText && /* @__PURE__ */ React.createElement("span", { className: "dshpm-published" }, " · ", fmt(t("publishedAt"), publishedText)))), /* @__PURE__ */ React.createElement("div", { className: "dshpm-field" }, /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-key" }, t("source")), /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-val" }, /* @__PURE__ */ React.createElement("span", { className: "dshpm-pill" }, row.sourceType === "local" ? t("sourceLocal") : row.sourceType === "github" ? t("sourceGithub") : t("sourceNpm")), " ", /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-field-val is-code",
			style: { display: "inline" },
			title: row.spec
		}, row.spec), row.repo && /* @__PURE__ */ React.createElement("span", null, "  ", /* @__PURE__ */ React.createElement("a", {
			href: "https://" + row.repo,
			target: "_blank",
			rel: "noreferrer",
			className: "dshpm-repo-link",
			title: row.repo
		}, row.repo)))), /* @__PURE__ */ React.createElement("div", { className: "dshpm-field" }, /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-key" }, t("description")), /* @__PURE__ */ React.createElement("span", { className: "dshpm-field-val" }, row.description || t("noDescription"))), /* @__PURE__ */ React.createElement("div", { className: "dshpm-detail-actions" }, canUpdate ? /* @__PURE__ */ React.createElement("button", {
			className: "dshpm-btn dshpm-btn-update",
			disabled: busy,
			title: t("updateTitle"),
			onClick: onBeginUpdate
		}, p === "update" ? t("updating") : t("update")) : null, row.protected || row.self ? /* @__PURE__ */ React.createElement("span", {
			className: "dshpm-hint",
			title: row.self ? t("selfHint") : t("protectedToggle")
		}, row.self ? t("selfHint") : t("protectedUninstall")) : /* @__PURE__ */ React.createElement("button", {
			className: "dshpm-btn dshpm-btn-danger",
			disabled: busy,
			title: t("uninstallTitle"),
			onClick: onBeginUninstall
		}, busy && p === "uninstall" ? t("uninstalling") : t("uninstall")))) : null);
	}

//#endregion
//#region src/client/components/ConfirmModal.tsx
/**
	* 运行时探测平台 Modal / Button（dshmarket 同款）。不可用（模块缺席、
	* 导出 undefined、非组件的坏 shim）返回 null，调用方走 window.confirm 回退。
	* 探测接受函数与 $$typeof 包装对象——宿主 0.2.0 起 Button 是 forwardRef，
	* 只认 `typeof === 'function'` 会让确认框永远不渲染（点更新/卸载无反应）。
	*/
	function platformModal() {
		try {
			const { Modal, Button } = getRequire()("@deepseek-ai/dsh-client-ui-primitives") ?? {};
			if (!isRenderableComponent(Modal) || !isRenderableComponent(Button)) return null;
			return {
				Modal,
				Button
			};
		} catch {
			return null;
		}
	}
	/** 平台确认框是否可用（PluginManagerTab 用它决定是否走原生 confirm 回退）。 */
	function platformModalAvailable() {
		return platformModal() !== null;
	}
	function ConfirmModal(props) {
		const { confirming, updates, t, onClose, onConfirm } = props;
		const React = getReact();
		const { Fragment } = React;
		const platform = platformModal();
		if (confirming === null || !(platform !== null)) return null;
		const { Modal, Button } = platform;
		const isUpdate = confirming.kind === "update";
		const latest = updates[confirming.row.name] && updates[confirming.row.name]?.latest || "";
		const title = isUpdate ? fmt(t("confirmUpdate"), confirming.row.name, latest) : confirming.row.version !== "-" ? fmt(t("confirmUninstall"), confirming.row.name, confirming.row.version) : fmt(t("confirmUninstallNoVer"), confirming.row.name);
		return /* @__PURE__ */ React.createElement(Modal, {
			open: true,
			onClose,
			title,
			description: isUpdate ? t("updateTitle") : t("uninstallTitle"),
			footer: /* @__PURE__ */ React.createElement(Fragment, null, /* @__PURE__ */ React.createElement(Button, {
				variant: "ghost",
				onClick: onClose
			}, t("cancel")), /* @__PURE__ */ React.createElement(Button, {
				variant: "primary",
				onClick: () => {
					onClose();
					onConfirm(confirming.kind, confirming.row);
				}
			}, isUpdate ? t("update") : t("uninstall")))
		}, confirming.row.self ? /* @__PURE__ */ React.createElement("p", { style: {
			fontSize: "12px",
			color: "var(--dsw-alias-label-tertiary,#888)",
			marginTop: "4px",
			marginBottom: "0"
		} }, isUpdate ? t("confirmUpdateSelf") : t("confirmSelf")) : null);
	}

//#endregion
//#region src/client/PluginManagerTab.tsx
/**
	* 「插件管理」tab 组件。
	* 手风琴卡片：行内常显 名称 + 状态文本 + switch；点箭头（或行）展开详情。
	*/
	function PluginManagerTab({ t, locale }) {
		const React = getReact();
		const { useState, useEffect, useCallback, useRef } = React;
		const [state, setState] = useState({
			loading: true,
			error: null,
			data: null
		});
		const [pending, setPending] = useState({});
		const { toasts, addToast, dismissToast } = useToasts();
		const [refreshedAt, setRefreshedAt] = useState(null);
		const [expanded, setExpanded] = useState({});
		const [confirming, setConfirming] = useState(null);
		const COLUMNS_KEY = "dsh-plugin-mgr:columns";
		const [columns, setColumns] = useState(() => {
			try {
				return localStorage.getItem(COLUMNS_KEY) === "2" ? 2 : 1;
			} catch {
				return 1;
			}
		});
		const [, setLocaleTick] = useState(0);
		const [updates, setUpdates] = useState({});
		const [query, setQuery] = useState("");
		const rootRef = useRef(null);
		useEffect(() => {
			ensureCss();
			const el = rootRef.current;
			if (!el) return;
			const findScrollParent = (node) => {
				let p = node.parentElement;
				while (p && p !== document.body) {
					const oy = getComputedStyle(p).overflowY;
					if (oy === "auto" || oy === "scroll" || oy === "overlay") return p;
					p = p.parentElement;
				}
				return null;
			};
			const fit = () => {
				const top = el.getBoundingClientRect().top;
				const sp = findScrollParent(el);
				let avail;
				if (sp) {
					const sr = sp.getBoundingClientRect();
					const pb = parseFloat(getComputedStyle(sp).paddingBottom) || 0;
					avail = sr.bottom - pb - top - 4;
				} else avail = window.innerHeight - top - 24;
				el.style.maxHeight = `${Math.max(avail, 240)}px`;
			};
			fit();
			const ro = new ResizeObserver(fit);
			ro.observe(document.body);
			ro.observe(el);
			window.addEventListener("resize", fit);
			return () => {
				ro.disconnect();
				window.removeEventListener("resize", fit);
			};
		}, [!!state.data && !state.error]);
		useEffect(() => {
			if (!locale || typeof locale.subscribe !== "function") return;
			return locale.subscribe(() => setLocaleTick((n) => n + 1));
		}, [locale]);
		const changeColumns = (n) => {
			setColumns(n);
			try {
				localStorage.setItem(COLUMNS_KEY, String(n));
			} catch {}
		};
		const loadData = useCallback(async (silent) => {
			setState((s) => ({
				...s,
				loading: true,
				error: null
			}));
			try {
				const json = await get(API.list);
				if (!json.ok) throw new Error(json.error || "unknown error");
				setState({
					loading: false,
					error: null,
					data: json
				});
				if (!silent) setRefreshedAt(/* @__PURE__ */ new Date());
			} catch (e) {
				setState((s) => ({
					...s,
					loading: false,
					error: e.message
				}));
			}
		}, []);
		useEffect(() => {
			loadData(true);
		}, [loadData]);
		useEffect(() => {
			if (refreshedAt === null) return;
			const timer = setTimeout(() => setRefreshedAt(null), 1500);
			return () => clearTimeout(timer);
		}, [refreshedAt]);
		const fetchUpdates = useCallback(async () => {
			try {
				const json = await get(API.updates);
				if (!json.ok) return;
				setUpdates(json.updates || {});
			} catch {}
		}, []);
		useEffect(() => {
			if (state.data) fetchUpdates();
		}, [state.data, fetchUpdates]);
		const clearPending = (name) => setPending((s) => {
			const next = { ...s };
			delete next[name];
			return next;
		});
		const toggleExpand = (name) => {
			setExpanded((s) => ({
				...s,
				[name]: !s[name]
			}));
		};
		const toggle = async (row) => {
			const disable = !row.disabled;
			setPending((s) => ({
				...s,
				[row.name]: "toggle"
			}));
			try {
				await post(API.toggle, {
					name: row.name,
					disable
				});
				addToast("ok", fmt(disable ? t("disabledMsg") : t("enabledMsg"), row.name));
				setTimeout(() => {
					clearPending(row.name);
					loadData();
				}, 1300);
			} catch (e) {
				addToast("error", fmt(t("toggleFail"), row.name, e.message));
				clearPending(row.name);
			}
		};
		const uninstall = async (row) => {
			setPending((s) => ({
				...s,
				[row.name]: "uninstall"
			}));
			try {
				await post(API.uninstall, {
					name: row.name,
					selfConfirm: true
				});
				addToast("ok", fmt(t("uninstalledMsg"), row.name));
				setExpanded((s) => ({
					...s,
					[row.name]: false
				}));
				loadData();
			} catch (e) {
				addToast("error", fmt(t("uninstallFail"), row.name, e.message));
			} finally {
				clearPending(row.name);
			}
		};
		const update = async (row) => {
			const info = updates[row.name];
			const latest = info && info.latest || "";
			setPending((s) => ({
				...s,
				[row.name]: "update"
			}));
			try {
				const json = await post(API.update, {
					name: row.name,
					selfConfirm: true
				});
				if (json.updated === false) addToast("error", fmt(t("updateSkipped"), row.name, json.version || row.version));
				else addToast("ok", fmt(t("updatedMsg"), row.name, json.version || latest));
				await loadData(true);
				fetchUpdates();
			} catch (e) {
				addToast("error", fmt(t("updateFail"), row.name, e.message));
			} finally {
				clearPending(row.name);
			}
		};
		const confirmText = (kind, row) => {
			const text = kind === "update" ? fmt(t("confirmUpdate"), row.name, updates[row.name]?.latest || "") : row.version !== "-" ? fmt(t("confirmUninstall"), row.name, row.version) : fmt(t("confirmUninstallNoVer"), row.name);
			const selfNote = row.self ? kind === "update" ? t("confirmUpdateSelf") : t("confirmSelf") : null;
			return selfNote !== null ? `${text}\n${selfNote}` : text;
		};
		const beginUninstall = (row) => {
			if (!platformModalAvailable()) {
				if (window.confirm(confirmText("uninstall", row))) uninstall(row);
				return;
			}
			setConfirming({
				kind: "uninstall",
				row: {
					name: row.name,
					version: row.version,
					self: row.self,
					protected: row.protected
				}
			});
		};
		const beginUpdate = (row) => {
			if (!platformModalAvailable()) {
				if (window.confirm(confirmText("update", row))) update(row);
				return;
			}
			setConfirming({
				kind: "update",
				row: {
					name: row.name,
					version: row.version,
					self: row.self,
					protected: row.protected
				}
			});
		};
		const onConfirmAction = (kind, row) => {
			const target = state.data?.plugins.find((p) => p.name === row.name);
			if (!target) return;
			if (kind === "update") update(target);
			else uninstall(target);
		};
		if (state.loading && !state.data) return /* @__PURE__ */ React.createElement("div", { className: "dshpm-root" }, /* @__PURE__ */ React.createElement("div", { className: "dshpm-loading" }, t("loading")));
		if (state.error && !state.data) return /* @__PURE__ */ React.createElement("div", { className: "dshpm-root" }, /* @__PURE__ */ React.createElement("div", { className: "dshpm-banner dshpm-banner-err" }, t("loadError"), " ", state.error), /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("button", {
			className: "dshpm-btn",
			onClick: () => loadData(false)
		}, t("retry"))));
		const data = state.data || {
			profile: "",
			plugins: []
		};
		const plugins = data.plugins || [];
		const q = query.trim().toLowerCase();
		const hasFilter = q !== "";
		const visible = plugins.filter((row) => {
			if (q !== "" && !`${row.name}\n${row.description}\n${row.spec}`.toLowerCase().includes(q)) return false;
			return true;
		});
		return /* @__PURE__ */ React.createElement("div", {
			ref: rootRef,
			className: `dshpm-root${columns === 2 ? " is-cols-2" : ""}`
		}, /* @__PURE__ */ React.createElement(Toolbar, {
			t,
			profile: data.profile,
			total: plugins.length,
			visibleCount: visible.length,
			hasFilter,
			query,
			onQueryChange: setQuery,
			columns,
			onColumnsChange: changeColumns,
			refreshing: state.loading && !!state.data,
			onRefresh: () => loadData(false)
		}), state.error && state.data && /* @__PURE__ */ React.createElement("div", { className: "dshpm-banner dshpm-banner-err" }, t("loadError"), " ", state.error), refreshedAt !== null && /* @__PURE__ */ React.createElement("div", {
			className: "dshpm-banner dshpm-banner-ok",
			"aria-live": "polite"
		}, fmt(t("refreshedAt"), refreshedAt.toLocaleTimeString())), /* @__PURE__ */ React.createElement("div", { className: "dshpm-list-area" }, plugins.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "dshpm-empty" }, t("empty")) : visible.length === 0 ? /* @__PURE__ */ React.createElement("div", { className: "dshpm-empty" }, /* @__PURE__ */ React.createElement("div", null, t("emptyFiltered")), /* @__PURE__ */ React.createElement("div", { style: { marginTop: "10px" } }, /* @__PURE__ */ React.createElement("button", {
			className: "dshpm-btn",
			onClick: () => setQuery("")
		}, t("clearFilters")))) : /* @__PURE__ */ React.createElement("ul", { className: "dshpm-list" }, visible.map((row) => /* @__PURE__ */ React.createElement(PluginCard, {
			key: row.name,
			t,
			row,
			upd: updates[row.name],
			pending: pending[row.name],
			open: !!expanded[row.name],
			onToggleExpand: () => toggleExpand(row.name),
			onToggle: () => toggle(row),
			onBeginUpdate: () => beginUpdate(row),
			onBeginUninstall: () => beginUninstall(row)
		})))), /* @__PURE__ */ React.createElement(ConfirmModal, {
			confirming,
			updates,
			t,
			onClose: () => setConfirming(null),
			onConfirm: onConfirmAction
		}), /* @__PURE__ */ React.createElement(ToastHost, {
			toasts,
			onDismiss: dismissToast,
			t
		}));
	}

//#endregion
//#region src/client/main.tsx
/** client 侧依赖：slots（注册 UI slot 的服务）+ locale（多语言词典） */
	const inject = ["slots", "locale"];
	function apply(ctx) {
		const React = getReact();
		ensureCss();
		ctx.effect(() => ctx.locale.register(NS, {
			zh,
			en
		}), "dsh-plugin-mgr: dictionaries");
		const t = ctx.locale.bind(NS);
		ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
			name: "settings.plugins.tab",
			id: "installed-manager",
			order: 20,
			label: () => t("tab"),
			locale: NS
		}, () => /* @__PURE__ */ React.createElement(PluginManagerTab, {
			t,
			locale: ctx.locale
		})));
	}

//#endregion
//#region src/client.tsx
	window.__ModuleLoader__.load({
		id: "dsh-plugin-mgr",
		factory: (require) => {
			provideReact(require("react"));
			provideRequire(require);
			return {
				apply,
				inject
			};
		}
	});

//#endregion
})();