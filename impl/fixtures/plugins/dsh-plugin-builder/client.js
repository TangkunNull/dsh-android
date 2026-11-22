window.__ModuleLoader__.load({
  id: "dsh-plugin-builder",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
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

// src-client/index.tsx
var src_client_exports = {};
__export(src_client_exports, {
  apply: () => apply,
  default: () => src_client_default,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(src_client_exports);

// src-client/PluginBuilderTab.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var import_jsx_runtime = require("react/jsx-runtime");
var ENGINE_STORAGE_KEY = "dsh-plugin-builder.engine";
var DEFAULT_ENGINE = "claude-code";
var ENGINE_OPTIONS = [
  {
    id: "claude-code",
    label: "Claude Code \u7F16\u7A0B\u6A21\u5F0F\uFF08\u63A8\u8350\uFF09",
    description: "\u4F7F\u7528\u5B8C\u6574\u7684 Claude Code \u7F16\u7A0B\u5185\u6838\u9605\u8BFB\u3001\u4FEE\u6539\u5E76\u9A8C\u8BC1\u4EE3\u7801\u3002"
  },
  {
    id: "cordis",
    label: "Cordis \u521B\u9020\u6A21\u5F0F",
    description: "\u9002\u5408\u52A8\u6001 Cordis \u63D2\u4EF6\u548C\u8FD0\u884C\u65F6\u80FD\u529B\u7684\u5FEB\u901F\u8BBE\u8BA1\u4E0E\u9A8C\u8BC1\u3002"
  },
  {
    id: "standard",
    label: "\u6807\u51C6\u6A21\u5F0F",
    description: "\u4F7F\u7528 DSH \u6807\u51C6\u5DE5\u5177\u94FE\u5B8C\u6210\u63D2\u4EF6\u5F00\u53D1\u3002"
  }
];
function storedEngine() {
  if (typeof localStorage === "undefined") return void 0;
  try {
    const value = localStorage.getItem(ENGINE_STORAGE_KEY);
    return ENGINE_OPTIONS.some((option) => option.id === value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function saveEngine(engine) {
  if (typeof localStorage === "undefined") return;
  try {
    if (engine === void 0) localStorage.removeItem(ENGINE_STORAGE_KEY);
    else localStorage.setItem(ENGINE_STORAGE_KEY, engine);
  } catch {
  }
}
var styles = {
  root: { display: "flex", flexDirection: "column", gap: 18, maxWidth: 720, padding: "8px 2px 24px" },
  hero: { padding: 20, border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 16, background: "var(--dsw-alias-bg-module-platform)" },
  eyebrow: { margin: "0 0 6px", color: "var(--dsw-alias-state-business-primary)", fontSize: 12, fontWeight: 600 },
  title: { margin: 0, color: "var(--dsw-alias-label-primary)", fontSize: 20, lineHeight: 1.4 },
  description: { margin: "8px 0 0", color: "var(--dsw-alias-label-secondary)", fontSize: 13, lineHeight: 1.7 },
  form: { display: "flex", flexDirection: "column", gap: 8 },
  engineRow: { display: "flex", flexDirection: "column", gap: 6, marginBottom: 4 },
  engineControl: { display: "flex", flexDirection: "column", gap: 6, width: "min(100%, 320px)" },
  label: { color: "var(--dsw-alias-label-primary)", fontSize: 13, fontWeight: 500 },
  select: { width: "100%", minHeight: 36, padding: "7px 10px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 9, outline: "none", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: 13 },
  engineDescription: { margin: 0, color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: 1.6 },
  remember: { display: "inline-flex", alignItems: "center", gap: 7, color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
  textarea: { boxSizing: "border-box", width: "100%", minHeight: 150, resize: "vertical", padding: "12px 14px", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, outline: "none", background: "var(--dsw-alias-bg-layer-1)", color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: 13, lineHeight: 1.65 },
  note: { margin: 0, color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: 1.6 },
  actions: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" },
  error: { margin: 0, padding: "8px 10px", borderRadius: 8, color: "var(--dsw-alias-state-error-primary)", background: "rgba(217,45,32,.08)", fontSize: 12 }
};
function PluginBuilderTab({ launch }) {
  const [requirement, setRequirement] = (0, import_react.useState)("");
  const initialEngine = storedEngine();
  const [engine, setEngine] = (0, import_react.useState)(initialEngine ?? DEFAULT_ENGINE);
  const [rememberEngine, setRememberEngine] = (0, import_react.useState)(initialEngine !== void 0);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [error, setError] = (0, import_react.useState)(null);
  const start = async () => {
    if (busy || requirement.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      saveEngine(rememberEngine ? engine : void 0);
      await launch(requirement.trim(), engine);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: styles.root, "data-plugin-builder-tab": true, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.hero, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.eyebrow, children: "DSH \u63D2\u4EF6\u5236\u4F5C\u5668" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: styles.title, children: "\u4ECE\u4E00\u53E5\u9700\u6C42\u5F00\u59CB\u5236\u4F5C\u63D2\u4EF6" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.description, children: "\u5B83\u4F1A\u5148\u8C03\u67E5\u63A5\u53E3\u5E76\u7ED9\u51FA\u65B9\u6848\uFF1B\u754C\u9762\u63D2\u4EF6\u8FD8\u4F1A\u5148\u751F\u6210\u53EF\u64CD\u4F5C\u539F\u578B\u3002\u53EA\u6709\u4F60\u786E\u8BA4\u65B9\u6848\u540E\u624D\u5F00\u59CB\u5B9E\u73B0\uFF0C\u5168\u90E8\u9A8C\u8BC1\u901A\u8FC7\u540E\u8FD8\u4F1A\u518D\u6B21\u8BE2\u95EE\u662F\u5426\u5B89\u88C5\u3002" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.form, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.engineRow, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.engineControl, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { htmlFor: "dsh-plugin-builder-engine", style: styles.label, children: "\u5236\u4F5C\u5F15\u64CE" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "select",
            {
              id: "dsh-plugin-builder-engine",
              style: styles.select,
              value: engine,
              onChange: (event) => setEngine(event.currentTarget.value),
              disabled: busy,
              children: ENGINE_OPTIONS.map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: option.id, children: option.label }, option.id))
            }
          ),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: styles.remember, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                checked: rememberEngine,
                onChange: (event) => {
                  const checked = event.currentTarget.checked;
                  setRememberEngine(checked);
                  if (!checked) saveEngine(void 0);
                },
                disabled: busy
              }
            ),
            "\u8BB0\u4F4F\u6B64\u9009\u62E9"
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: styles.engineDescription, children: [
          ENGINE_OPTIONS.find((option) => option.id === engine)?.description,
          " ",
          "\u5236\u4F5C\u5668\u4F1A\u65B0\u5EFA\u72EC\u7ACB\u4F1A\u8BDD\uFF0C\u4E0D\u4F1A\u6539\u53D8\u5F53\u524D\u5BF9\u8BDD\u7684\u6A21\u5F0F\u548C\u4E0A\u4E0B\u6587\u3002"
        ] })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { htmlFor: "dsh-plugin-builder-requirement", style: styles.label, children: "\u4F60\u5E0C\u671B\u63D2\u4EF6\u5B8C\u6210\u4EC0\u4E48\uFF1F" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "textarea",
        {
          id: "dsh-plugin-builder-requirement",
          style: styles.textarea,
          value: requirement,
          onChange: (event) => setRequirement(event.currentTarget.value),
          placeholder: "\u4F8B\u5982\uFF1A\u5236\u4F5C\u4E00\u4E2A\u63D2\u4EF6\uFF0C\u628A\u5F53\u524D\u5DE5\u4F5C\u533A\u7684\u6D4B\u8BD5\u7ED3\u679C\u6C47\u603B\u6210\u4FA7\u8FB9\u5361\u7247\uFF0C\u5E76\u652F\u6301\u5BFC\u51FA Markdown\u3002",
          disabled: busy,
          autoFocus: true
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.actions, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: styles.note, children: "\u70B9\u51FB\u540E\u53EA\u4F1A\u628A\u6307\u4EE4\u653E\u5165\u5BF9\u8BDD\u6846\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u53D1\u9001\u6216\u4FEE\u6539\u914D\u7F6E\u3002" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { size: "sm", onClick: () => void start(), disabled: busy || requirement.trim() === "", children: busy ? "\u6B63\u5728\u51C6\u5907\u2026" : "\u653E\u5165\u5BF9\u8BDD\u6846\u5E76\u5F00\u59CB\u8BBE\u8BA1" })
      ] }),
      error !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "alert", style: styles.error, children: error }) : null
    ] })
  ] });
}

// src-client/skill-draft.ts
async function placeSkillPromptInDraft(ctx, prompt, options = {}) {
  const normalized = prompt.trim();
  if (normalized === "") throw new Error("\u8BF7\u5148\u586B\u5199\u9700\u6C42\u3002");
  const snapshot = ctx.sessions.list.getSnapshot();
  let sessionId = options.dedicatedSession === true ? void 0 : snapshot.current;
  if (sessionId === void 0) {
    if (options.agentPreset !== void 0) {
      await assertPresetAvailable(ctx, options.agentPreset);
    }
    sessionId = await ctx.sessions.create(inheritedLocation(ctx, snapshot));
    if (options.agentPreset !== void 0) {
      await selectPreset(ctx, sessionId, options.agentPreset);
    }
    ctx.sessions.open(sessionId);
  }
  const scope = ctx.sessions.scope(sessionId);
  if (scope === void 0) throw new Error("\u5F53\u524D\u4F1A\u8BDD\u5C1A\u672A\u51C6\u5907\u597D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
  const conversation = ctx.get("conversation");
  if (conversation === void 0) throw new Error("\u5BF9\u8BDD\u8F93\u5165\u6846\u5C1A\u672A\u51C6\u5907\u597D\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
  const input = conversation.input.for(scope);
  const previous = input.state.getSnapshot().draft.trim();
  input.setDraft(previous === "" ? normalized : `${previous}

${normalized}`);
  return sessionId;
}
function inheritedLocation(ctx, snapshot) {
  const current = snapshot.current;
  if (current === void 0) return void 0;
  const workspace = ctx.workspaces?.list.getSnapshot().items?.find((item) => item.sessionIds.includes(current));
  if (workspace !== void 0) return { workspaceId: workspace.workspaceId };
  const cwd = snapshot.byId?.[current]?.cwd;
  return cwd === void 0 ? void 0 : { cwd };
}
function presetService(ctx) {
  const service = ctx.remote?.agentPresets;
  if (service === void 0) {
    throw new Error("\u5F53\u524D DSH \u6CA1\u6709\u63D0\u4F9B\u7F16\u7A0B\u6A21\u5F0F\u670D\u52A1\uFF0C\u8BF7\u66F4\u65B0\u6216\u4FEE\u590D\u5B89\u88C5\u540E\u91CD\u8BD5\u3002");
  }
  return service;
}
async function assertPresetAvailable(ctx, agentPreset) {
  const roster = await presetService(ctx).list();
  if (!roster.ok) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u5236\u4F5C\u6A21\u5F0F\uFF1A${roster.error.message}`);
  }
  const preset = roster.value.presets.find((item) => item.id === agentPreset);
  if (preset === void 0) {
    throw new Error(`\u5F53\u524D\u5B89\u88C5\u4E0D\u5305\u542B\u201C${presetDisplayName(agentPreset)}\u201D\uFF0C\u8BF7\u9009\u62E9\u5176\u4ED6\u5236\u4F5C\u5F15\u64CE\u3002`);
  }
  if (preset.broken !== void 0) {
    throw new Error(`\u201C${presetDisplayName(agentPreset)}\u201D\u5F53\u524D\u4E0D\u53EF\u7528\uFF1A${preset.broken}`);
  }
}
async function selectPreset(ctx, sessionId, agentPreset) {
  const selected = await presetService(ctx).select(sessionId, agentPreset);
  if (!selected.ok) {
    throw new Error(`\u65E0\u6CD5\u542F\u7528\u201C${presetDisplayName(agentPreset)}\u201D\uFF1A${selected.error.message}`);
  }
}
function presetDisplayName(agentPreset) {
  if (agentPreset === "claude-code") return "Claude Code \u7F16\u7A0B\u6A21\u5F0F";
  if (agentPreset === "cordis") return "Cordis \u521B\u9020\u6A21\u5F0F";
  if (agentPreset === "standard") return "\u6807\u51C6\u6A21\u5F0F";
  return agentPreset;
}
function focusComposerSoon() {
  if (typeof document === "undefined") return;
  globalThis.setTimeout(() => {
    document.querySelector("[data-composer-seat] textarea")?.focus();
  }, 0);
}

// src-client/index.tsx
var name = "dsh-plugin-builder";
var inject = ["slots", "sessions", "conversation", "workspaces", "remote", "remote.agentPresets"];
var ENGINE_PRESETS = {
  "claude-code": "claude-code",
  cordis: "cordis",
  standard: "standard"
};
function apply(ctx) {
  const launch = async (requirement, engine) => {
    await placeSkillPromptInDraft(
      ctx,
      `/cordis-plugin-development \u6839\u636E\u4EE5\u4E0B\u9700\u6C42\u8BBE\u8BA1\u5E76\u5236\u4F5C\u4E00\u4E2A DSH \u63D2\u4EF6\uFF1A

${requirement}`,
      { dedicatedSession: true, agentPreset: ENGINE_PRESETS[engine] }
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    focusComposerSoon();
  };
  ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
    name: "settings.plugins.tab",
    id: "builder",
    order: 100,
    label: () => "\u667A\u80FD\u5236\u4F5C",
    inject: () => ({ launch })
  }, PluginBuilderTab));
}
var src_client_default = { name, inject, apply };
    return module.exports;
  }
});
