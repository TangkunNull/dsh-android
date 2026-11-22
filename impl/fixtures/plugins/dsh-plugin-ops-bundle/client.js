window.__ModuleLoader__.load({ id: "dsh-plugin-ops-bundle", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);

// src/client/HealthSection.tsx
var import_react = require("react");

// src/client/i18n.ts
var DICTS = {
  zh: {
    title: "健康检查",
    subtitle: "dsh-ops 内嵌面板：扫描当前 profile 的插件健康状态",
    feedback: "反馈",
    refresh: "刷新",
    scan: "扫描",
    scanning: "扫描中…",
    fix: "修复",
    fixing: "修复中…",
    clean: "未发现问题",
    fatal: "致命",
    warn: "警告",
    info: "信息",
    findings: "扫描结果",
    rows: "插件行管理",
    filterAll: "全部",
    filterFatal: "致命",
    filterWarn: "警告",
    filterOk: "正常",
    disable: "禁用",
    enable: "启用",
    protectedTag: "官方保护",
    versionNote: "版本",
    disabledTag: "已禁用",
    prev: "上一页",
    next: "下一页",
    pageOf: "第 {cur} / {total} 页",
    timeline: "故障时间线",
    emptyTimeline: "暂无记录",
    chat: "诊断对话",
    chatHint: "基于当前 profile 的实时扫描结果；建议的修复请用上方白名单按钮执行",
    chatWelcome: "我是诊断助手。已载入当前 profile 的扫描结果，想问什么？",
    chatPlaceholder: "问：这些警告是什么意思？该怎么处理？",
    chatSend: "发送",
    chatThinking: "思考中…",
    chatNoChannel: "未找到可用模型通道（dsh 未提供 llm 服务且未配置 API key）",
    ragToggle: "增强检索（知识库）",
    btnDeposit: "沉淀为知识",
    depositOk: "已沉淀为知识条目",
    depositFail: "沉淀失败：",
    depositNoChat: "先进行一轮对话再沉淀",
    knowledge: "知识库（插件排障经验）",
    knowledgeHint: "bug 与修复经验沉淀为 md；开关开启时诊断对话自动检索命中条目",
    knowledgePlaceholder: "搜索：错误信息 / 包名 / 规则…",
    search: "搜索",
    showAll: "全部",
    knowledgeEmpty: "暂无知识条目（修复成功或对话沉淀后自动积累）",
    knowledgeSearchEmpty: "无命中条目",
    delete: "删除",
    times: "出现 {n} 次",
    loadFail: "加载失败：",
    profile: "Profile",
    home: "DSH_HOME",
    adapt: "安装适配",
    adaptHint: "对官方门禁拒绝的插件做豁免安装；隔离 canary 验证在 CLI 版（dsh-ops adapt）",
    adaptPlaceholder: "npm 包名（如 dsh-aimail@0.1.30）",
    adaptCheck: "检查并安装",
    adaptWorking: "处理中…",
    adaptInstalled: "安装完成",
    adaptRefused: "官方门禁拒绝：与当前 dsh 不兼容",
    adaptRequirements: "未满足的要求",
    adaptRiskNarrow: "风险：窄范围",
    adaptRiskCross: "风险：跨 breaking 边界",
    adaptWarning: "豁免 = 明确接受崩溃/数据丢失风险（官方原文）；面板版不做隔离 canary，安装失败会自动撤销豁免",
    adaptConfirm: "豁免并安装",
    adaptCancel: "取消",
    adaptDone: "已豁免安装；重启 dsh 生效",
    adaptDetail: "安装详情",
    exemptions: "豁免清单",
    exemptionsEmpty: "暂无豁免",
    revoke: "撤销",
    uninstallCleanup: "卸载并清理",
    preview: "升级预演",
    previewHint: "目标版本会跳过哪些第三方插件，及每个的修法；只读",
    previewTargetPlaceholder: "目标版本（留空 = 最新已知）",
    previewUpdates: "含 registry 检查（慢）",
    previewRun: "运行预演",
    previewRunning: "预演中…",
    previewNoSkip: "该目标下没有被跳过的插件",
    previewSkipped: "{n} 个插件会被跳过",
    previewCopy: "复制",
    previewCopied: "已复制",
    previewTargetLabel: "目标版本",
    previewRunningLabel: "当前运行",
    previewVerdict: { skipped: "跳过", exempted: "已豁免", compatible: "兼容", retired: "退役", unresolved: "未解析" }
  },
  en: {
    title: "Health Check",
    subtitle: "Embedded dsh-ops panel: plugin health of the current profile",
    feedback: "Feedback",
    refresh: "Refresh",
    scan: "Scan",
    scanning: "Scanning…",
    fix: "Fix",
    fixing: "Fixing…",
    clean: "No findings",
    fatal: "Fatal",
    warn: "Warn",
    info: "Info",
    findings: "Scan results",
    rows: "Plugin rows",
    filterAll: "All",
    filterFatal: "Fatal",
    filterWarn: "Warn",
    filterOk: "OK",
    disable: "Disable",
    enable: "Enable",
    protectedTag: "official",
    versionNote: "version",
    disabledTag: "disabled",
    prev: "Prev",
    next: "Next",
    pageOf: "Page {cur} / {total}",
    timeline: "Fault timeline",
    emptyTimeline: "No records",
    chat: "Diagnosis chat",
    chatHint: "Based on a live scan of the current profile; use the whitelisted buttons above to apply suggested fixes",
    chatWelcome: "Diagnosis assistant here. The current profile scan is loaded — what would you like to know?",
    chatPlaceholder: "Ask: what do these warnings mean? How do I fix them?",
    chatSend: "Send",
    chatThinking: "Thinking…",
    chatNoChannel: "No model channel available (dsh exposes no llm service and no API key is configured)",
    ragToggle: "Enhanced retrieval (knowledge base)",
    btnDeposit: "Deposit as knowledge",
    depositOk: "Deposited as a knowledge entry",
    depositFail: "Deposit failed: ",
    depositNoChat: "Chat once before depositing",
    knowledge: "Knowledge base (plugin troubleshooting)",
    knowledgeHint: "Bugs and fixes deposit as Markdown; the toggle retrieves matching entries for the chat",
    knowledgePlaceholder: "Search: error text / package / rule…",
    search: "Search",
    showAll: "All",
    knowledgeEmpty: "No entries yet (fixes and deposits accumulate here)",
    knowledgeSearchEmpty: "No matches",
    delete: "Delete",
    times: "seen {n}×",
    loadFail: "Load failed: ",
    profile: "Profile",
    home: "DSH_HOME",
    adapt: "Installation adaptation",
    adaptHint: "exempt-install a plugin the official gate rejects; the isolated canary lives in the CLI (dsh-ops adapt)",
    adaptPlaceholder: "npm package (e.g. dsh-aimail@0.1.30)",
    adaptCheck: "Check & install",
    adaptWorking: "Working…",
    adaptInstalled: "Installed",
    adaptRefused: "Refused by the official gate: incompatible with this dsh",
    adaptRequirements: "Unmet requirements",
    adaptRiskNarrow: "Risk: narrow",
    adaptRiskCross: "Risk: cross-breaking",
    adaptWarning: "An exemption explicitly accepts crash/data-loss risk (official wording); the panel skips the isolated canary and revokes the exemption automatically when the install fails",
    adaptConfirm: "Exempt & install",
    adaptCancel: "Cancel",
    adaptDone: "Installed with an exemption; restart dsh to activate",
    adaptDetail: "Install details",
    exemptions: "Exemptions",
    exemptionsEmpty: "No exemptions",
    revoke: "Revoke",
    uninstallCleanup: "Uninstall & clean",
    preview: "Upgrade preview",
    previewHint: "which third-party plugins the target release skips, and each fix; read-only",
    previewTargetPlaceholder: "Target version (empty = newest known)",
    previewUpdates: "Include registry check (slow)",
    previewRun: "Run preview",
    previewRunning: "Rehearsing…",
    previewNoSkip: "No plugin would be skipped by this target",
    previewSkipped: "{n} plugin(s) would be skipped",
    previewCopy: "Copy",
    previewCopied: "Copied",
    previewTargetLabel: "target",
    previewRunningLabel: "running",
    previewVerdict: { skipped: "skipped", exempted: "exempted", compatible: "compatible", retired: "retired", unresolved: "unresolved" }
  }
};
function detectLang() {
  const nav = typeof navigator === "undefined" ? "" : navigator.language;
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}
function format(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
}

// src/client/HealthSection.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var API = "/dsh-ops";
var PAGE_SIZE = 10;
function packageNameOf(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) return key;
  return key.slice(at + 1).includes("/") ? key : key.slice(0, at);
}
async function api(path, init) {
  const res = await fetch(`${API}${path}`, {
    method: init?.method ?? "GET",
    ...init?.body === void 0 ? {} : { body: init.body },
    headers: { "Content-Type": "application/json" }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
var STYLE_ID = "dsh-ops-health-style";
var CSS = `
.dshops-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}
.dshops-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshops-title{font-size:15px;font-weight:600;margin-right:auto}
.dshops-sub{opacity:.65;font-size:12px}
.dshops-btn{border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}
.dshops-btn:disabled{opacity:.5;cursor:default}
.dshops-btn-primary{background:#4d6bfe;border-color:#4d6bfe;color:#fff}
.dshops-select{border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;border-radius:6px;padding:3px 6px;font-size:12px;color-scheme:light}
.dshops-select option{background:#fff;color:#000}
.dshops-card{border:1px solid rgba(128,128,128,.25);border-radius:8px;padding:10px 12px}
.dshops-card h3{margin:0 0 8px;font-size:13px;font-weight:600}
.dshops-counts{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshops-pill{border-radius:10px;padding:1px 8px;font-size:11px}
.dshops-pill-fatal{background:rgba(229,57,53,.15);color:#e53935}
.dshops-pill-warn{background:rgba(251,140,0,.18);color:#fb8c00}
.dshops-pill-info{background:rgba(30,136,229,.15);color:#1e88e5}
.dshops-pill-ok{background:rgba(67,160,71,.15);color:#43a047}
.dshops-list{display:flex;flex-direction:column;gap:6px}
.dshops-item{border-left:3px solid rgba(128,128,128,.35);padding:4px 8px;background:rgba(128,128,128,.06);border-radius:4px}
.dshops-item-fatal{border-left-color:#e53935;background:rgba(229,57,53,.07)}
.dshops-item-warn{border-left-color:#fb8c00;background:rgba(251,140,0,.07)}
.dshops-row{display:flex;align-items:center;gap:8px;padding:4px 6px;border-bottom:1px solid rgba(128,128,128,.12)}
.dshops-row:last-child{border-bottom:none}
.dshops-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.dshops-dim{opacity:.6}
.dshops-chat{display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto}
.dshops-msg{max-width:85%;padding:6px 10px;border-radius:8px;white-space:pre-wrap}
.dshops-msg-user{align-self:flex-end;background:rgba(77,107,254,.18)}
.dshops-msg-assistant{align-self:flex-start;background:rgba(128,128,128,.12)}
.dshops-chatbar{display:flex;gap:6px;margin-top:8px}
.dshops-input{flex:1;border:1px solid rgba(128,128,128,.35);border-radius:6px;padding:5px 8px;background:transparent;color:inherit;font-size:12px}
.dshops-err{color:#e53935;font-size:12px}
.dshops-footer{display:flex;align-items:center;gap:8px;margin-top:8px}
`;
function useStyles() {
  (0, import_react.useEffect)(() => {
    if (document.getElementById(STYLE_ID) !== null) return;
    const el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
  }, []);
}
function severityOf(row, scan) {
  if (scan === null) return "ok";
  let worst = "ok";
  for (const finding of scan.findings) {
    if (finding.packageName === void 0) continue;
    if (finding.packageName !== row.packageName && finding.packageName !== row.rowId) continue;
    if (finding.severity === "fatal") return "fatal";
    if (finding.severity === "warn") worst = "warn";
  }
  return worst;
}
function HealthSection() {
  useStyles();
  const [lang, setLang] = (0, import_react.useState)(detectLang);
  const t = DICTS[lang];
  const [info, setInfo] = (0, import_react.useState)(null);
  const [profile, setProfile] = (0, import_react.useState)("");
  const [scan, setScan] = (0, import_react.useState)(null);
  const [rows, setRows] = (0, import_react.useState)([]);
  const [events, setEvents] = (0, import_react.useState)([]);
  const [filter, setFilter] = (0, import_react.useState)("all");
  const [page, setPage] = (0, import_react.useState)(0);
  const [chat, setChat] = (0, import_react.useState)([]);
  const [chatInput, setChatInput] = (0, import_react.useState)("");
  const [chatState, setChatState] = (0, import_react.useState)("");
  const [rag, setRag] = (0, import_react.useState)(false);
  const [knowledge, setKnowledge] = (0, import_react.useState)([]);
  const [knowledgeQuery, setKnowledgeQuery] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)("");
  const [adaptSpec, setAdaptSpec] = (0, import_react.useState)("");
  const [adaptBusy, setAdaptBusy] = (0, import_react.useState)(false);
  const [adaptRefused, setAdaptRefused] = (0, import_react.useState)(null);
  const [adaptNotice, setAdaptNotice] = (0, import_react.useState)("");
  const [adaptError, setAdaptError] = (0, import_react.useState)("");
  const [adaptDetail, setAdaptDetail] = (0, import_react.useState)("");
  const [exemptions, setExemptions] = (0, import_react.useState)({});
  const [previewTarget, setPreviewTarget] = (0, import_react.useState)("");
  const [previewUpdates, setPreviewUpdates] = (0, import_react.useState)(false);
  const [preview, setPreview] = (0, import_react.useState)(null);
  const [previewBusy, setPreviewBusy] = (0, import_react.useState)(false);
  const [previewError, setPreviewError] = (0, import_react.useState)("");
  const [previewNotice, setPreviewNotice] = (0, import_react.useState)("");
  const load = (0, import_react.useCallback)(async (name, scanOnly = false) => {
    setError("");
    setBusy(scanOnly ? "scan" : "load");
    try {
      const encoded = encodeURIComponent(name);
      const scanRes = await api(`/api/scan?profile=${encoded}`);
      setScan(scanRes);
      if (!scanOnly) {
        const [rowsRes, memRes] = await Promise.all([
          api(`/api/plugins?profile=${encoded}`),
          api(`/api/memory?profile=${encoded}`)
        ]);
        setRows(rowsRes.rows);
        setEvents(memRes.events);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  }, []);
  const loadKnowledge = (0, import_react.useCallback)(async () => {
    try {
      const res = await api("/api/knowledge");
      setKnowledge(res.entries);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const loadExemptions = (0, import_react.useCallback)(async () => {
    try {
      const res = await api("/api/adapt/exemptions");
      setExemptions(res.exemptions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  (0, import_react.useEffect)(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem("dshops-rag") === "1") setRag(true);
  }, []);
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    void (async () => {
      try {
        const infoRes = await api("/api/info");
        if (cancelled) return;
        setInfo(infoRes);
        const initial = infoRes.defaultProfile ?? infoRes.profiles[0]?.name ?? "web";
        setProfile(initial);
        await load(initial);
        await loadKnowledge();
        await loadExemptions();
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, loadKnowledge, loadExemptions]);
  const changeProfile = (name) => {
    setProfile(name);
    setPage(0);
    setScan(null);
    setRows([]);
    setEvents([]);
    setChat([]);
    setPreview(null);
    setPreviewError("");
    void load(name);
  };
  const alignFindings = scan?.findings.filter((f) => f.severity === "fatal" && f.fix.kind === "align-lockfile") ?? [];
  const runFix = async () => {
    if (profile === "") return;
    setBusy("fix");
    setError("");
    try {
      await api(`/api/fix/execute?profile=${encodeURIComponent(profile)}`, { method: "POST", body: "{}" });
      await load(profile);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const toggleRow = async (row) => {
    setError("");
    try {
      const action = row.disabled ? "enable" : "disable";
      await api(`/api/plugins/${action}?profile=${encodeURIComponent(profile)}`, {
        method: "POST",
        body: JSON.stringify({ rowId: row.rowId })
      });
      await load(profile, true);
      const rowsRes = await api(`/api/plugins?profile=${encodeURIComponent(profile)}`);
      setRows(rowsRes.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const sendChat = async () => {
    const text = chatInput.trim();
    if (text === "" || busy === "chat") return;
    const next = [...chat, { role: "user", content: text }];
    setChat(next);
    setChatInput("");
    setBusy("chat");
    setChatState(t.chatThinking);
    try {
      const res = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ profile, lang, rag, messages: next })
      });
      if (res.ok) {
        setChat([...next, { role: "assistant", content: res.reply }]);
      } else {
        setChatState(res.error ?? t.chatNoChannel);
      }
    } catch (e) {
      setChatState(`${t.loadFail}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
      setChatState((state) => state === t.chatThinking ? "" : state);
    }
  };
  const toggleRag = (next) => {
    setRag(next);
    if (typeof localStorage !== "undefined") localStorage.setItem("dshops-rag", next ? "1" : "0");
  };
  const openFeedback = () => {
    const lines = [
      `- dsh-ops: ${info?.opsVersion ?? "unknown"}`,
      "- surface: embedded bundle (dsh settings)",
      `- OS: ${navigator.userAgent}`,
      `- profile: ${profile === "" ? "n/a" : profile}`,
      scan === null ? "- scan: not run" : `- scan: ${scan.counts.fatal} fatal / ${scan.counts.warn} warn`
    ];
    const body = `### Environment

${lines.join("\n")}

### What happened

<!-- describe the problem -->
`;
    const url = `https://github.com/f-infinite-z/dsh-plugin-ops/issues/new?template=bug.yml&title=${encodeURIComponent("[bug] ")}&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank");
  };
  const searchKnowledge = async () => {
    const query = knowledgeQuery.trim();
    if (query === "") {
      await loadKnowledge();
      return;
    }
    setError("");
    try {
      const res = await api(`/api/knowledge?q=${encodeURIComponent(query)}&limit=10`);
      setKnowledge(res.hits);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const removeKnowledge = async (id) => {
    try {
      await api("/api/knowledge/delete", { method: "POST", body: JSON.stringify({ id }) });
      await loadKnowledge();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const deposit = async () => {
    if (chat.length === 0) {
      setChatState(t.depositNoChat);
      return;
    }
    setBusy("deposit");
    setChatState("");
    try {
      const res = await api("/api/knowledge/deposit", {
        method: "POST",
        body: JSON.stringify({ lang, messages: chat })
      });
      if (res.ok) {
        setChatState(t.depositOk);
        await loadKnowledge();
      } else {
        setChatState(res.error ?? t.depositFail);
      }
    } catch (e) {
      setChatState(`${t.depositFail}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };
  const runPreview = async () => {
    if (previewBusy || profile === "") return;
    setPreviewBusy(true);
    setPreviewError("");
    setPreviewNotice("");
    try {
      const params = new URLSearchParams({ profile });
      const target = previewTarget.trim();
      if (target !== "") params.set("target", target);
      if (previewUpdates) params.set("updates", "true");
      const res = await api(`/api/preview?${params.toString()}`);
      setPreview(res);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewBusy(false);
    }
  };
  const runAdapt = async () => {
    const spec = adaptSpec.trim();
    if (spec === "" || adaptBusy) return;
    setAdaptBusy(true);
    setAdaptNotice("");
    setAdaptRefused(null);
    setAdaptError("");
    setAdaptDetail("");
    try {
      const res = await api("/api/adapt/install", { method: "POST", body: JSON.stringify({ spec }) });
      if (res.ok) {
        setAdaptNotice(`${t.adaptInstalled}: ${res.bundle ?? res.target ?? spec}${res.application === "restart-required" ? " — restart required" : ""}`);
        setAdaptSpec("");
        await load(profile);
        await loadExemptions();
      } else if (res.code === "incompatible-version" && res.incompatible !== void 0) {
        setAdaptRefused({ spec, items: res.incompatible, ...res.message === void 0 ? {} : { message: res.message } });
      } else {
        setAdaptError(`${res.code ?? "error"}: ${res.message ?? ""}`);
        setAdaptDetail(res.detail ?? "");
      }
    } catch (e) {
      setAdaptError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdaptBusy(false);
    }
  };
  const confirmAdapt = async () => {
    if (adaptRefused === null || adaptBusy) return;
    const refused = adaptRefused;
    setAdaptBusy(true);
    setAdaptError("");
    setAdaptDetail("");
    try {
      for (const item of refused.items) {
        const res = await api("/api/adapt/apply", {
          method: "POST",
          body: JSON.stringify({ spec: refused.spec, name: item.name, version: item.version, runtimeVersion: item.runtimeVersion })
        });
        if (!res.ok) {
          setAdaptError(`${res.code ?? "error"}: ${res.message ?? ""}${res.rolledBack === true ? " — exemption rolled back" : ""}`);
          setAdaptDetail(res.detail ?? "");
          await loadExemptions();
          return;
        }
      }
      setAdaptNotice(`${t.adaptDone}: ${refused.spec}`);
      setAdaptRefused(null);
      setAdaptSpec("");
      await load(profile);
      await loadExemptions();
    } catch (e) {
      setAdaptError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdaptBusy(false);
    }
  };
  const revokeExemption = async (name) => {
    setAdaptError("");
    setAdaptDetail("");
    try {
      await api("/api/adapt/revoke", { method: "POST", body: JSON.stringify({ name }) });
      await loadExemptions();
    } catch (e) {
      setAdaptError(e instanceof Error ? e.message : String(e));
    }
  };
  const removePlugin = async (name) => {
    setAdaptError("");
    setAdaptDetail("");
    try {
      const res = await api("/api/adapt/remove", { method: "POST", body: JSON.stringify({ name }) });
      if (!res.ok) {
        setAdaptError(`${res.code ?? "error"}: ${res.message ?? ""}`);
        setAdaptDetail(res.detail ?? "");
        return;
      }
      await load(profile);
      await loadExemptions();
    } catch (e) {
      setAdaptError(e instanceof Error ? e.message : String(e));
    }
  };
  const visibleRows = rows.filter((row) => filter === "all" || severityOf(row, scan) === filter);
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const pageRows = visibleRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-root", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-title", children: t.title }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-sub", children: t.subtitle }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", onClick: () => setLang(lang === "zh" ? "en" : "zh"), children: lang === "zh" ? "EN" : "中文" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", onClick: openFeedback, children: t.feedback }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", disabled: profile === "" || busy !== "", onClick: () => void load(profile), children: busy === "scan" ? t.scanning : t.refresh }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn dshops-btn-primary", disabled: profile === "" || busy !== "", onClick: () => void load(profile, true), children: t.scan })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-dim", children: [
        t.profile,
        ":"
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", { className: "dshops-select", value: profile, onChange: (e) => changeProfile(e.target.value), children: (info?.profiles ?? []).map((p) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("option", { value: p.name, children: [
        p.name,
        " (",
        p.bundles,
        ")"
      ] }, p.name)) }),
      info !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim dshops-mono", children: info.home })
    ] }),
    error !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-err", children: error }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t.findings }),
      scan === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim", children: busy === "load" ? t.scanning : "" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-counts", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-pill dshops-pill-fatal", children: [
            t.fatal,
            " ",
            scan.counts.fatal
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-pill dshops-pill-warn", children: [
            t.warn,
            " ",
            scan.counts.warn
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-pill dshops-pill-info", children: [
            t.info,
            " ",
            scan.counts.info
          ] }),
          scan.ok && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-pill dshops-pill-ok", children: t.clean }),
          alignFindings.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", disabled: busy !== "", onClick: () => void runFix(), children: busy === "fix" ? t.fixing : t.fix })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-list", style: { marginTop: 8 }, children: scan.findings.map((finding, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `dshops-item dshops-item-${finding.severity}`, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dshops-pill dshops-pill-${finding.severity}`, children: finding.severity }),
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-mono", children: [
            "[",
            finding.ruleId,
            "]"
          ] }),
          " ",
          finding.packageName !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-mono", children: finding.packageName }),
          " ",
          finding.message,
          finding.detail !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", children: finding.detail }),
          finding.versionNote !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-dim", children: [
            t.versionNote,
            ": ",
            finding.versionNote
          ] })
        ] }, `${finding.ruleId}-${index}`)) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { children: [
        t.rows,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { className: "dshops-select", value: filter, onChange: (e) => {
          setFilter(e.target.value);
          setPage(0);
        }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "all", children: t.filterAll }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "fatal", children: t.filterFatal }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "warn", children: t.filterWarn }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "ok", children: t.filterOk })
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        pageRows.map((row) => {
          const severity = severityOf(row, scan);
          return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dshops-pill dshops-pill-${severity === "ok" ? "ok" : severity}`, children: severity }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-mono", children: row.rowId }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim dshops-mono", children: row.packageName ?? "" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { marginLeft: "auto" }, className: "dshops-dim", children: [
              row.protected && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-pill", children: t.protectedTag }),
              row.disabled && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-pill dshops-pill-warn", children: t.disabledTag })
            ] }),
            !row.protected && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", disabled: busy !== "", onClick: () => void toggleRow(row), children: row.disabled ? t.enable : t.disable })
          ] }, `${row.rowId}-${row.source}`);
        }),
        visibleRows.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", children: t.clean })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-footer", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", disabled: page <= 0, onClick: () => setPage((p) => Math.max(0, p - 1)), children: t.prev }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim", children: format(t.pageOf, { cur: page + 1, total: totalPages }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", disabled: page + 1 >= totalPages, onClick: () => setPage((p) => p + 1), children: t.next })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { children: [
        t.preview,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim", children: t.previewHint })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-chatbar", style: { marginTop: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            className: "dshops-input",
            value: previewTarget,
            placeholder: t.previewTargetPlaceholder,
            onChange: (e) => setPreviewTarget(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void runPreview();
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "label",
          {
            className: "dshops-dim",
            style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" },
            children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: previewUpdates, onChange: (e) => setPreviewUpdates(e.target.checked) }),
              t.previewUpdates
            ]
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn dshops-btn-primary", disabled: previewBusy || profile === "", onClick: () => void runPreview(), children: previewBusy ? t.previewRunning : t.previewRun })
      ] }),
      previewError !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-err", style: { marginTop: 6 }, children: previewError }),
      preview !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-dim", style: { fontSize: 12, marginBottom: 6 }, children: [
          t.previewTargetLabel,
          ": ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-mono", children: preview.target.version }),
          " ·",
          " ",
          t.previewRunningLabel,
          ": ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-mono", children: preview.runningVersion ?? "?" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginBottom: 6 }, children: preview.counts.skipped > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-pill dshops-pill-warn", children: format(t.previewSkipped, { n: preview.counts.skipped }) }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-pill dshops-pill-ok", children: t.previewNoSkip }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-list", children: preview.entries.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: `dshops-item${entry.verdict === "skipped" ? " dshops-item-warn" : ""}`, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "span",
              {
                className: `dshops-pill dshops-pill-${entry.verdict === "skipped" ? "warn" : entry.verdict === "compatible" ? "ok" : "info"}`,
                children: t.previewVerdict[entry.verdict] ?? entry.verdict
              }
            ),
            " ",
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-mono", children: [
              entry.name,
              "@",
              entry.version ?? "?"
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", style: { fontSize: 12 }, children: entry.detail }),
          entry.commands.map((command) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 6, alignItems: "center", marginTop: 4 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { className: "dshops-mono", style: { fontSize: 11, wordBreak: "break-all" }, children: command }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                className: "dshops-btn",
                style: { fontSize: 11, padding: "1px 6px" },
                onClick: () => {
                  void navigator.clipboard.writeText(command).then(() => setPreviewNotice(t.previewCopied));
                },
                children: t.previewCopy
              }
            )
          ] }, command))
        ] }, entry.name)) }),
        previewNotice !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", style: { fontSize: 11, marginTop: 4 }, children: previewNotice })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { children: [
        t.adapt,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim", children: t.adaptHint })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-chatbar", style: { marginTop: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            className: "dshops-input",
            value: adaptSpec,
            placeholder: t.adaptPlaceholder,
            onChange: (e) => setAdaptSpec(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void runAdapt();
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            className: "dshops-btn dshops-btn-primary",
            disabled: adaptBusy || adaptSpec.trim() === "",
            onClick: () => void runAdapt(),
            children: adaptBusy ? t.adaptWorking : t.adaptCheck
          }
        )
      ] }),
      adaptError !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-err", style: { marginTop: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { whiteSpace: "pre-wrap" }, children: adaptError }),
        adaptDetail !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { style: { marginTop: 4 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { style: { cursor: "pointer" }, children: t.adaptDetail }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: { maxHeight: 200, overflow: "auto", fontSize: 11, margin: "4px 0 0", whiteSpace: "pre-wrap" }, children: adaptDetail })
        ] })
      ] }),
      adaptRefused !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-item dshops-item-warn", style: { marginTop: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t.adaptRefused }),
          adaptRefused.message !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-dim", children: [
            " — ",
            adaptRefused.message
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-dim", style: { fontSize: 11, marginTop: 4 }, children: [
          t.adaptRequirements,
          ":"
        ] }),
        adaptRefused.items.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 4 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-mono", children: [
            item.name,
            "@",
            item.version
          ] }),
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `dshops-pill dshops-pill-${item.risk === "narrow" ? "warn" : "fatal"}`, children: item.risk === "narrow" ? t.adaptRiskNarrow : t.adaptRiskCross }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim dshops-mono", style: { fontSize: 11 }, children: Object.entries(item.requirements ?? item.peers ?? {}).map(([name, range]) => `${name}: ${range}`).join(", ") })
        ] }, `${item.name}@${item.version}`)),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", style: { fontSize: 11, marginTop: 6 }, children: t.adaptWarning }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 6, display: "flex", gap: 6 }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn dshops-btn-primary", disabled: adaptBusy, onClick: () => void confirmAdapt(), children: adaptBusy ? t.adaptWorking : t.adaptConfirm }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", disabled: adaptBusy, onClick: () => setAdaptRefused(null), children: t.adaptCancel })
        ] })
      ] }),
      adaptNotice !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", style: { marginTop: 6 }, children: adaptNotice })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t.exemptions }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-list", children: [
        Object.entries(exemptions).map(([key, runtimes]) => {
          const name = packageNameOf(key);
          return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-mono", children: key }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim dshops-mono", children: runtimes.join(", ") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { marginLeft: "auto", display: "flex", gap: 6 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", onClick: () => void revokeExemption(name), children: t.revoke }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", onClick: () => void removePlugin(name), children: t.uninstallCleanup })
            ] })
          ] }, key);
        }),
        Object.keys(exemptions).length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", children: t.exemptionsEmpty })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { children: [
        t.knowledge,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim", children: t.knowledgeHint })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-chatbar", style: { marginTop: 0, marginBottom: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            className: "dshops-input",
            value: knowledgeQuery,
            placeholder: t.knowledgePlaceholder,
            onChange: (e) => setKnowledgeQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void searchKnowledge();
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", onClick: () => void searchKnowledge(), children: t.search }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            className: "dshops-btn",
            onClick: () => {
              setKnowledgeQuery("");
              void loadKnowledge();
            },
            children: t.showAll
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-list", children: [
        knowledge.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 12 }, children: item.title }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim", style: { fontSize: 11 }, children: [
              item.occurrences === void 0 ? "" : format(t.times, { n: item.occurrences }),
              item.score === void 0 ? "" : `${t.search}: ${item.score}`,
              item.source ?? "",
              item.createdAt === void 0 ? "" : item.createdAt.slice(0, 10)
            ].filter((text) => text !== "").join(" · ") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", style: { marginLeft: "auto" }, onClick: () => void removeKnowledge(item.id), children: t.delete })
          ] }),
          item.tags !== void 0 && item.tags.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", style: { fontSize: 11 }, children: item.tags.join(", ") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { fontSize: 12, whiteSpace: "pre-wrap" }, children: (item.symptom ?? "") + (item.fix !== void 0 && item.fix !== "" ? `
→ ${item.fix}` : "") })
        ] }, item.id)),
        knowledge.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", children: t.knowledgeEmpty })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t.timeline }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-list", children: [
        events.map((event, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-item", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-mono", children: event.ts }),
          " ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dshops-mono", children: [
            "[",
            event.type,
            "]"
          ] }),
          " ",
          event.detail
        ] }, `${event.ts}-${index}`)),
        events.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-dim", children: t.emptyTimeline })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-card", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("h3", { children: [
        t.chat,
        " ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dshops-dim", children: t.chatHint })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-head", style: { marginBottom: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dshops-dim", style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "checkbox", checked: rag, onChange: (e) => toggleRag(e.target.checked) }),
          t.ragToggle
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn", style: { marginLeft: "auto" }, disabled: busy !== "", onClick: () => void deposit(), children: busy === "deposit" ? t.chatThinking : t.btnDeposit })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-chat", children: [
        chat.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-msg dshops-msg-assistant dshops-dim", children: t.chatWelcome }),
        chat.map((message, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: `dshops-msg dshops-msg-${message.role}`, children: message.content }, index))
      ] }),
      chatState !== "" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dshops-err", style: { marginTop: 6 }, children: chatState }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dshops-chatbar", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            className: "dshops-input",
            value: chatInput,
            placeholder: t.chatPlaceholder,
            onChange: (e) => setChatInput(e.target.value),
            onKeyDown: (e) => {
              if (e.key === "Enter") void sendChat();
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dshops-btn dshops-btn-primary", disabled: busy === "chat", onClick: () => void sendChat(), children: busy === "chat" ? t.chatThinking : t.chatSend })
      ] })
    ] })
  ] });
}

// src/client/SandboxPanel.tsx
var import_react2 = require("react");

// src/client/sandbox-i18n.ts
var SANDBOX_DICTS = {
  zh: {
    title: "沙箱实例",
    subtitle: "隔离实例：用于插件配置的测试与修复。注意：它继承你的环境与文件权限（用户级 npm 凭据 ~/.npmrc、git 凭据同样可在沙箱内读到），请勿用于不可信代码",
    subtitleDesktop: "隔离的第二个桌面窗口：独立 user-data 与 DSH home，用于插件配置的测试与修复。注意：它继承你的环境与文件权限（DSH_HOME 之外不隔离——插件可读写整个用户目录，用户级 npm 凭据 ~/.npmrc、git 凭据同样可在沙箱内读到），请勿用于不可信代码",
    start: "启动沙箱",
    stop: "停止并清理",
    restart: "重启（保留现场）",
    open: "打开沙箱",
    scan: "扫描沙箱",
    diagnose: "读取诊断",
    refresh: "刷新",
    stateStopped: "已停止",
    stateStarting: "启动中",
    stateRunning: "运行中",
    stateStopping: "停止中",
    url: "地址",
    home: "沙箱 home",
    problem: "问题",
    noProblem: "无",
    findings: "扫描发现",
    noFindings: "未发现问题",
    errorLines: "错误输出",
    crashReport: "崩溃报告",
    installTitle: "安装插件（进沙箱）",
    installHint: "输入 npm 包名或 name@版本；装完自动回读校验注册，半注册残留自动 remove→add 修复；新装约 3 秒热加载",
    installPlaceholder: "例如 dsh-whale-widget 或 @scope/name@0.4.2",
    installApply: "安装到沙箱",
    installOk: "已安装并注册",
    installRecovered: "已安装并注册（经 remove→add 修复）",
    installFail: "未安装/未注册——详见步骤",
    approveBuilds: "批准构建脚本（之后重试安装）",
    approveBuildsOk: "构建门已解决——请再次点击安装",
    approveBuildsFail: "未能解决构建门",
    lastSession: "上次会话验证过",
    fixTitle: "修复（禁用行并重启验证）",
    fixHint: "输入要禁用的 loader 行 id（通常即包名）；沙箱会重启以证明修复有效",
    fixPlaceholder: "行 id，例如 dsh-some-plugin（多个用逗号分隔）",
    fixApply: "应用修复",
    fixApplied: "已写入：",
    fixFailed: "写入失败：",
    fixNotApplied: "未禁用任何行，沙盒未重启",
    restartHeld: "沙箱在禁用这些行后成功启动（说明它们不是唯一阻塞）",
    restartBroke: "禁用这些行后沙箱仍未启动；请查看日志与诊断，尝试其他行",
    useRow: "禁用此行",
    logs: "运行日志",
    startFirst: "先启动沙箱",
    busy: "处理中…",
    guide: "启动隔离的 2 号 dsh，在这里测试有风险的新插件"
  },
  en: {
    title: "Sandbox instance",
    subtitle: "Isolated instance for plugin configuration work. Note: it inherits your environment and file-system access (user-level npm credentials in ~/.npmrc and git credentials are readable from the sandbox too) — not for untrusted code",
    subtitleDesktop: "Isolated second desktop window: its own user-data directory and DSH home, for plugin configuration work. Note: it inherits your environment and file-system access (nothing outside DSH_HOME is isolated — plugins can read/write your whole user directory, including user-level npm credentials in ~/.npmrc and git credentials) — not for untrusted code",
    start: "Start sandbox",
    stop: "Stop and clean up",
    restart: "Restart (keep state)",
    open: "Open sandbox",
    scan: "Scan sandbox",
    diagnose: "Read diagnostics",
    refresh: "Refresh",
    stateStopped: "stopped",
    stateStarting: "starting",
    stateRunning: "running",
    stateStopping: "stopping",
    url: "URL",
    home: "sandbox home",
    problem: "problem",
    noProblem: "none",
    findings: "Scan findings",
    noFindings: "no findings",
    errorLines: "Error output",
    crashReport: "Crash report",
    installTitle: "Install a plugin (into the sandbox)",
    installHint: "npm spec (name or name@version); the install reads the profile back to verify registration and repairs a half-registered residue with remove + add; a new bundle hot-loads in ~3s",
    installPlaceholder: "e.g. dsh-whale-widget or @scope/name@0.4.2",
    installApply: "Install into sandbox",
    installOk: "installed and registered",
    installRecovered: "installed and registered (recovered with remove + add)",
    installFail: "not installed/registered — see the steps",
    approveBuilds: "Approve build scripts (then retry the install)",
    approveBuildsOk: "the build gate is resolved — click install again",
    approveBuildsFail: "could not resolve the build gate",
    lastSession: "Last session verified",
    fixTitle: "Repair (disable rows and restart to prove it)",
    fixHint: "Enter loader row ids to disable (usually the package name); the sandbox restarts so the repair is proven",
    fixPlaceholder: "row id, e.g. dsh-some-plugin (comma-separated for several)",
    fixApply: "Apply repair",
    fixApplied: "written: ",
    fixFailed: "failed: ",
    fixNotApplied: "no rows were disabled; the sandbox was not restarted",
    restartHeld: "the sandbox booted with these rows disabled: they are not the sole blocker",
    restartBroke: "the sandbox still failed with these rows disabled; check the log and diagnostics and try other rows",
    useRow: "disable this row",
    logs: "Runtime log",
    startFirst: "start the sandbox first",
    busy: "working…",
    guide: "Start an isolated number-2 dsh to test risky plugins here"
  }
};

// src/client/SandboxPanel.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
var API2 = "/dsh-ops";
var POLL_MS = 2500;
var MAX_LOG_LINES = 400;
var STYLE_ID2 = "dsh-ops-sandbox-style";
function useStyle() {
  (0, import_react2.useEffect)(() => {
    if (document.getElementById(STYLE_ID2) !== null) return;
    const el = document.createElement("style");
    el.id = STYLE_ID2;
    el.textContent = `
.dshops-sb { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.5; height: 100%; overflow: auto; }
.dshops-sb .sb-badge { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 11px; margin-left: 6px; }
.dshops-sb .sb-stopped { background: rgba(127,127,127,.18); }
.dshops-sb .sb-running { background: rgba(46,160,67,.22); }
.dshops-sb .sb-pending { background: rgba(210,153,34,.25); }
.dshops-sb-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.dshops-sb button { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: transparent; cursor: pointer; }
.dshops-sb button:disabled { opacity: .5; cursor: default; }
.dshops-sb .sb-kv { display: flex; gap: 6px; }
.dshops-sb .sb-kv .k { opacity: .65; flex: none; }
.dshops-sb .sb-url { word-break: break-all; }
.dshops-sb .sb-problem { color: #d29922; white-space: pre-wrap; }
.dshops-sb .sb-msg { white-space: pre-wrap; }
.dshops-sb .sb-finding { border-left: 3px solid rgba(127,127,127,.4); padding: 2px 0 2px 8px; margin: 4px 0; }
.dshops-sb .sb-fatal { border-color: #f85149; }
.dshops-sb .sb-warn { border-color: #d29922; }
.dshops-sb .sb-info { border-color: #58a6ff; }
.dshops-sb .sb-fixrow { display: flex; gap: 6px; }
.dshops-sb .sb-fixrow input { flex: 1; min-width: 0; font-size: 12px; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
.dshops-sb pre.sb-log { margin: 0; padding: 8px; border-radius: 6px; background: rgba(127,127,127,.1); max-height: 260px; overflow: auto; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.dshops-sb .sb-section { font-weight: 600; margin-top: 2px; }
.dshops-sb .sb-dim { opacity: .65; }
`;
    document.head.appendChild(el);
  }, []);
}
async function api2(path, init) {
  const res = await fetch(`${API2}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof data.message === "string" ? data.message : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}
function SandboxPanel() {
  useStyle();
  const lang = (0, import_react2.useMemo)(() => detectLang(), []);
  const t = SANDBOX_DICTS[lang];
  const [status, setStatus] = (0, import_react2.useState)(null);
  const [logs, setLogs] = (0, import_react2.useState)([]);
  const [busy, setBusy] = (0, import_react2.useState)(null);
  const [findings, setFindings] = (0, import_react2.useState)(null);
  const [scanNote, setScanNote] = (0, import_react2.useState)(null);
  const [errorLines, setErrorLines] = (0, import_react2.useState)(null);
  const [crashFile, setCrashFile] = (0, import_react2.useState)(null);
  const [fixInput, setFixInput] = (0, import_react2.useState)("");
  const [installInput, setInstallInput] = (0, import_react2.useState)("");
  const [installMsg, setInstallMsg] = (0, import_react2.useState)(null);
  const [lastSession, setLastSession] = (0, import_react2.useState)(null);
  const [message, setMessage] = (0, import_react2.useState)(null);
  const seqRef = (0, import_react2.useRef)(0);
  const logRef = (0, import_react2.useRef)(null);
  const refresh = (0, import_react2.useCallback)(async () => {
    try {
      const data = await api2(`/api/sandbox/status?after=${seqRef.current}`);
      setStatus(data.status);
      if (data.logs.length > 0) {
        seqRef.current = data.nextSeq;
        setLogs((prev) => [...prev, ...data.logs].slice(-MAX_LOG_LINES));
      }
    } catch {
    }
  }, []);
  (0, import_react2.useEffect)(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [refresh]);
  (0, import_react2.useEffect)(() => {
    void (async () => {
      try {
        const data = await api2("/api/sandbox/report");
        if (data.report !== null && data.report !== void 0) {
          setLastSession({ packages: data.report.packages ?? [], endedAt: data.report.endedAt ?? null });
        }
      } catch {
      }
    })();
  }, []);
  (0, import_react2.useEffect)(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [logs]);
  const act = (0, import_react2.useCallback)(async (name, path, body) => {
    setBusy(name);
    setMessage(null);
    try {
      const data = await api2(path, {
        method: "POST",
        ...body === void 0 ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      });
      if (typeof data.status === "object" && data.status !== null) setStatus(data.status);
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);
  const runScan = (0, import_react2.useCallback)(async () => {
    setBusy("scan");
    setScanNote(null);
    try {
      const data = await api2("/api/sandbox/scan");
      if (data.ok) {
        setFindings(data.findings ?? []);
      } else {
        setScanNote(data.message ?? t.startFirst);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [t]);
  const runDiagnose = (0, import_react2.useCallback)(async () => {
    setBusy("diagnose");
    try {
      const data = await api2("/api/sandbox/diagnose");
      setErrorLines(data.diagnosis.errorLines);
      setCrashFile(data.diagnosis.crash?.file ?? null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, []);
  const applyFix = (0, import_react2.useCallback)(async () => {
    const rows = fixInput.split(/[,，\s]+/).map((row) => row.trim()).filter((row) => row !== "");
    if (rows.length === 0) return;
    const data = await act("fix", "/api/sandbox/fix", { rows });
    if (data === null) return;
    const applied = Array.isArray(data.applied) ? data.applied : [];
    const lines = applied.map((entry) => `${entry.ok ? t.fixApplied : t.fixFailed}${entry.row}`);
    const restarted = data.restarted === true;
    const restart = data.status;
    if (!restarted) {
      lines.push(t.fixNotApplied);
    } else if (restart !== void 0) {
      lines.push(restart.state === "running" ? t.restartHeld : t.restartBroke);
    }
    setMessage(lines.join("\n"));
  }, [act, fixInput, t]);
  const applyInstall = (0, import_react2.useCallback)(async () => {
    const spec = installInput.trim();
    if (spec === "") return;
    const data = await act("install", "/api/sandbox/install", { spec });
    if (data === null) return;
    const steps = Array.isArray(data.steps) ? data.steps : [];
    const lines = steps.map((step) => `${step.ok ? "ok" : "!!"} ${step.step}: ${step.detail}`);
    lines.push("");
    lines.push(data.ok === true ? data.recovered === true ? t.installRecovered : t.installOk : t.installFail);
    setInstallMsg(lines.join("\n"));
  }, [act, installInput, t]);
  const approveBuilds = (0, import_react2.useCallback)(async () => {
    const data = await act("approve-builds", "/api/sandbox/approve-builds", { allow: true });
    if (data === null) return;
    const applied = Array.isArray(data.applied) ? data.applied : [];
    const lines = applied.map((entry) => `${entry.ok ? "ok" : "!!"} ${entry.name} -> ${entry.allow ? "allow" : "deny"}`);
    lines.push("");
    lines.push(data.ok === true ? t.approveBuildsOk : t.approveBuildsFail);
    setInstallMsg(lines.join("\n"));
  }, [act, t]);
  const stateKey = status?.state ?? "stopped";
  const badgeClass = stateKey === "running" ? "sb-running" : stateKey === "stopped" ? "sb-stopped" : "sb-pending";
  const stateLabel = stateKey === "running" ? t.stateRunning : stateKey === "starting" ? t.stateStarting : stateKey === "stopping" ? t.stateStopping : t.stateStopped;
  const notStopped = stateKey === "running" || stateKey === "starting";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshops-sb", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-section", children: t.title }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `sb-badge ${badgeClass}`, children: stateLabel })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-dim", children: status?.kind === "desktop" ? t.subtitleDesktop : t.subtitle }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dshops-sb-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null || notStopped, onClick: () => {
        void act("start", "/api/sandbox/start");
      }, children: t.start }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null || stateKey !== "running", onClick: () => {
        void act("restart", "/api/sandbox/restart");
      }, children: t.restart }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null || !notStopped, onClick: () => {
        void act("stop", "/api/sandbox/stop");
      }, children: t.stop }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: status?.url === null || status?.url === void 0, onClick: () => {
        if (status?.url != null) window.open(status.url, "_blank", "noopener");
      }, children: t.open }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null, onClick: () => {
        void runScan();
      }, children: t.scan }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null, onClick: () => {
        void runDiagnose();
      }, children: t.diagnose }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null, onClick: () => {
        void refresh();
      }, children: t.refresh })
    ] }),
    busy !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-dim", children: t.busy }) : null,
    message !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-msg", children: message }) : null,
    status !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      status.url !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-kv", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "k", children: t.url }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-url", children: status.url })
      ] }) : null,
      status.home !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-kv", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "k", children: t.home }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "sb-url", children: status.home })
      ] }) : null,
      status.problem !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-problem", children: status.problem }) : null
    ] }) : null,
    lastSession !== null && lastSession.packages.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-section", children: t.lastSession }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-dim", children: [
        lastSession.packages.map((pkg) => `${pkg.name}@${pkg.version ?? "?"}`).join(", "),
        lastSession.endedAt !== null ? ` — ${lastSession.endedAt.slice(0, 19).replace("T", " ")}` : ""
      ] })
    ] }) : null,
    scanNote !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-dim", children: scanNote }) : null,
    findings !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-section", children: t.findings }),
      findings.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-dim", children: t.noFindings }) : findings.map((finding, index) => /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: `sb-finding sb-${finding.severity === "fatal" || finding.severity === "warn" ? finding.severity : "info"}`, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
          "[",
          finding.severity,
          "] ",
          finding.ruleId,
          ": ",
          finding.message
        ] }),
        finding.packageName !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "button",
          {
            onClick: () => {
              setFixInput((prev) => prev.trim() === "" ? finding.packageName : `${prev}, ${finding.packageName}`);
            },
            children: t.useRow
          }
        ) : null
      ] }, `${finding.ruleId}-${index}`))
    ] }) : null,
    errorLines !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-section", children: t.errorLines }),
      crashFile !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-dim", children: [
        t.crashReport,
        ": ",
        crashFile
      ] }) : null,
      errorLines.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-dim", children: t.noFindings }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "sb-log", children: errorLines.join("\n") })
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-section", children: t.installTitle }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-dim", children: t.installHint }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-fixrow", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            value: installInput,
            placeholder: t.installPlaceholder,
            onChange: (event) => {
              setInstallInput(event.target.value);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null || installInput.trim() === "" || stateKey !== "running", onClick: () => {
          void applyInstall();
        }, children: t.installApply })
      ] }),
      installMsg !== null ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "sb-log", children: installMsg }) : null,
      installMsg !== null && installMsg.includes("allowBuilds") ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null, onClick: () => {
        void approveBuilds();
      }, children: t.approveBuilds }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-section", children: t.fixTitle }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-dim", children: t.fixHint }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "sb-fixrow", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            value: fixInput,
            placeholder: t.fixPlaceholder,
            onChange: (event) => {
              setFixInput(event.target.value);
            }
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { disabled: busy !== null || fixInput.trim() === "" || !notStopped, onClick: () => {
          void applyFix();
        }, children: t.fixApply })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "sb-section", children: t.logs }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("pre", { className: "sb-log", ref: logRef, children: logs.map((entry) => entry.line).join("\n") })
    ] })
  ] });
}

// src/client/SandboxEntry.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
function openSafely(props) {
  try {
    props.open?.();
  } catch {
  }
}
function SandboxEntry(props) {
  const t = SANDBOX_DICTS[detectLang()];
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
    "button",
    {
      type: "button",
      title: `dsh-ops · ${t.title}`,
      "aria-label": `dsh-ops · ${t.title}`,
      onClick: () => {
        openSafely(props);
      },
      style: {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        border: "none",
        background: "transparent",
        borderRadius: 6,
        cursor: "pointer",
        color: "inherit",
        opacity: 0.85
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("svg", { width: "15", height: "15", viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: "1.4", "aria-hidden": "true", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("rect", { x: "2.5", y: "3", width: "11", height: "10", rx: "1.5" }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("path", { d: "M2.5 6.5h11M6 3V1.8M10 3V1.8" })
      ] })
    }
  );
}
function SandboxTitle() {
  const t = SANDBOX_DICTS[detectLang()];
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { children: t.title });
}
function SandboxGuide(props) {
  const t = SANDBOX_DICTS[detectLang()];
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
    "button",
    {
      type: "button",
      onClick: () => {
        openSafely(props);
      },
      style: {
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 10px",
        border: "1px solid rgba(127,127,127,.3)",
        borderRadius: 8,
        background: "transparent",
        cursor: "pointer",
        color: "inherit",
        fontSize: 12
      },
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { fontWeight: 600 }, children: t.title }),
        /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { style: { opacity: 0.65, marginTop: 2 }, children: t.guide })
      ]
    }
  );
}

// src/client/index.ts
var inject = ["slots"];
var SANDBOX_KIND = "dsh-ops-sandbox";
var SANDBOX_ID = "dsh-plugin-ops-bundle";
function apply(ctx) {
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "dsh-ops",
        order: 50,
        label: () => "dsh-ops"
      },
      HealthSection
    )
  );
  try {
    ctx.inject(["sidebarRight", "sidebarRightTabs"], (scoped) => {
      registerSandboxSurfaces(ctx, scoped);
    });
  } catch (error) {
    console.error("[dsh-ops] sandbox surfaces disabled:", error);
  }
}
function registerSandboxSurfaces(ctx, scoped) {
  const sidebarRight = scoped.get("sidebarRight");
  const tabs = scoped.get("sidebarRightTabs");
  if (sidebarRight === null || sidebarRight === void 0 || tabs === null || tabs === void 0 || typeof sidebarRight.openTab !== "function" || typeof tabs.register !== "function") {
    return;
  }
  const open = () => {
    sidebarRight.openTab(SANDBOX_KIND);
  };
  scoped.effect(() => tabs.register({
    id: SANDBOX_ID,
    kind: SANDBOX_KIND,
    multiple: false,
    title: () => SANDBOX_DICTS[detectLang()].title,
    guide: [{
      id: SANDBOX_KIND,
      order: 120,
      title: () => SANDBOX_DICTS[detectLang()].title,
      description: () => SANDBOX_DICTS[detectLang()].guide
    }]
  }), "dsh-ops-bundle: sandbox tab type");
  ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
    { name: "sidebar.right.pane.tab", key: SANDBOX_ID },
    SandboxPanel
  ));
  ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register(
    { name: "sidebar.right.pane.tab.title", key: SANDBOX_ID },
    SandboxTitle
  ));
  ctx.slots.inject("sidebar.right.tab.guide.entry", () => ctx.slots.register(
    {
      name: "sidebar.right.tab.guide.entry",
      key: SANDBOX_ID,
      inject: () => ({ open })
    },
    SandboxGuide
  ));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
    {
      name: "sidebar.footer.action",
      id: "dsh-ops-sandbox",
      order: 120,
      inject: () => ({ open })
    },
    SandboxEntry
  ));
}
return module.exports; } });
