window.__ModuleLoader__.load({ id: "dsh-plugin-install", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  NS: () => NS,
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(index_exports);

// src/client/detailSlots.tsx
var import_react = require("react");
var primitives = __toESM(require("@deepseek-ai/dsh-client-ui-primitives"), 1);

// src/client/store.ts
var state = { updates: {}, ops: {}, uninstalls: {}, relief: void 0, reliefBusy: false };
var listeners = /* @__PURE__ */ new Set();
function commit(next) {
  state = next;
  for (const listener of [...listeners]) listener();
}
function snapshot() {
  return state;
}
function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function patch(partial) {
  commit({ ...state, ...partial });
}
function updateCount() {
  return Object.values(state.updates).filter((status) => status.updateAvailable).length;
}
async function refresh(force = false) {
  try {
    const response = await fetch(`/dsh-plugin-install/updates${force ? "?force=1" : ""}`);
    const body = await response.json();
    if (!response.ok || body.updates === void 0) return;
    patch({ updates: body.updates });
  } catch {
  }
}
async function updatePlugin(name2) {
  if (state.ops[name2] === "updating") return;
  patch({ ops: { ...state.ops, [name2]: "updating" } });
  try {
    const response = await fetch("/dsh-plugin-install/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name2 })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.ok === true) {
      await refresh(false);
      const ops = { ...snapshot().ops };
      if (body.hot === true) delete ops[name2];
      else ops[name2] = "updated";
      patch({ ops });
    } else {
      fail(name2, body.error ?? `HTTP ${response.status}`);
    }
  } catch (error) {
    fail(name2, error instanceof Error ? error.message : String(error));
  }
}
function fail(name2, message) {
  patch({ ops: { ...snapshot().ops, [name2]: { error: message } } });
}
async function uninstallPlugin(name2) {
  if (state.uninstalls[name2] === "uninstalling") return false;
  patch({ uninstalls: { ...state.uninstalls, [name2]: "uninstalling" } });
  let message;
  try {
    const response = await fetch("/dsh-plugin-install/uninstall", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name2 })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.ok === true) {
      await refresh(false);
      const broken = body.integrity?.broken ?? [];
      if (broken.length > 0) {
        const pairs = broken.map((entry) => `${entry.plugin}\u2192${entry.requirement}`).join(", ");
        patch({ uninstalls: { ...snapshot().uninstalls, [name2]: { error: `integrity:${pairs}` } } });
        return false;
      }
      return true;
    }
    message = body.error ?? `HTTP ${response.status}`;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  patch({ uninstalls: { ...snapshot().uninstalls, [name2]: { error: message } } });
  return false;
}
async function restartHost() {
  if (window.dshDesktop !== void 0) return;
  const readBoot = () => fetch("/dsh-plugin-install/status").then((response) => response.json()).then((status) => status.boot).catch(() => void 0);
  const before = await readBoot();
  let handoff;
  try {
    const response = await fetch("/dsh-plugin-install/restart", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (response.ok) handoff = body.handoff;
  } catch {
  }
  const deadline = Date.now() + 9e4;
  for (; ; ) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1e3);
    });
    if (Date.now() > deadline) window.location.reload();
    try {
      const boot = await readBoot();
      if (boot !== void 0 && boot !== before) break;
    } catch {
    }
  }
  if (handoff !== void 0) {
    try {
      const handed = await fetch(`/dsh-plugin-install/handoff?nonce=${encodeURIComponent(handoff)}`);
      const body = await handed.json();
      if (handed.ok && body.url !== void 0) {
        window.location.replace(body.url);
        return;
      }
    } catch {
    }
  }
  window.location.reload();
}
async function refreshRelief() {
  try {
    const response = await fetch("/dsh-plugin-install/cooldown-relief");
    const body = await response.json().catch(() => ({}));
    if (response.ok && typeof body.enabled === "boolean") patch({ relief: body.enabled });
  } catch {
  }
}
async function setCooldownRelief(enabled) {
  if (state.reliefBusy) return false;
  patch({ reliefBusy: true });
  try {
    const response = await fetch("/dsh-plugin-install/cooldown-relief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && typeof body.enabled === "boolean") {
      patch({ relief: body.enabled });
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    patch({ reliefBusy: false });
  }
}

// src/client/detailSlots.tsx
var SELF_PACKAGE = "dsh-plugin-install";
var table = primitives;
function useUpdateStore() {
  (0, import_react.useSyncExternalStore)(subscribe, snapshot, snapshot);
}
function statusFor(subject) {
  if (subject.kind !== "bundle" || subject.pkg === void 0) return void 0;
  return snapshot().updates[subject.pkg.name];
}
function UpdateBadge({ subject, t: t2 }) {
  useUpdateStore();
  const status = statusFor(subject);
  if (status?.updateAvailable !== true) return null;
  const label = status.kind === "github" ? t2("newCommits") : status.latest !== null ? t2("badgeUpdate").replace("{version}", status.latest) : t2("updateAvailable");
  const Tag = table.Tag;
  if (typeof Tag !== "function") {
    return (0, import_react.createElement)("span", { className: "dpi-updateTag", style: { color: "var(--dsw-alias-state-success-primary)" } }, label);
  }
  return (0, import_react.createElement)(Tag, { tone: "success" }, label);
}
function UpdateAction({ subject, t: t2 }) {
  useUpdateStore();
  const name2 = subject.kind === "bundle" ? subject.pkg?.name : void 0;
  if (name2 === void 0) return null;
  const state2 = snapshot();
  const status = state2.updates[name2];
  const op = state2.ops[name2];
  const available = status?.updateAvailable === true;
  if (!available && op !== "updated") return null;
  if (!available && window.dshDesktop !== void 0) {
    return (0, import_react.createElement)("span", { title: t2("restartTrayTitle"), style: { color: "var(--dsw-alias-state-success-primary)" } }, t2("restartTrayLabel"));
  }
  const updating = available && op === "updating";
  const error = op !== void 0 && typeof op === "object" ? op.error : void 0;
  const label = available ? updating ? t2("updating") : error !== void 0 ? t2("updateFailed") : t2("updateBtn") : t2("restartShort");
  const Button = table.Button;
  if (typeof Button !== "function") {
    return (0, import_react.createElement)("button", {
      type: "button",
      disabled: updating,
      title: error,
      onClick: () => {
        void (available ? updatePlugin(name2) : restartHost());
      },
      style: { cursor: updating ? "default" : "pointer" }
    }, label);
  }
  return (0, import_react.createElement)(Button, {
    variant: "primary",
    size: "sm",
    disabled: updating,
    title: error,
    onClick: () => {
      void (available ? updatePlugin(name2) : restartHost());
    }
  }, label);
}
function CooldownReliefAction({ subject, t: t2 }) {
  useUpdateStore();
  (0, import_react.useEffect)(() => {
    void refreshRelief();
  }, []);
  if (subject.kind !== "bundle" || subject.pkg?.name !== SELF_PACKAGE) return null;
  const state2 = snapshot();
  if (state2.relief === void 0) return null;
  const enabled = state2.relief;
  const busy = state2.reliefBusy;
  const label = busy ? t2("reliefBusy") : enabled ? t2("reliefDisable") : t2("reliefEnable");
  const title = enabled ? t2("reliefHintOn") : t2("reliefHintOff");
  const Button = table.Button;
  if (typeof Button !== "function") {
    return (0, import_react.createElement)("button", {
      type: "button",
      disabled: busy,
      title,
      onClick: () => {
        void setCooldownRelief(!enabled);
      },
      style: { cursor: busy ? "default" : "pointer" }
    }, label);
  }
  return (0, import_react.createElement)(Button, {
    variant: enabled ? "ghost" : "outline",
    size: "sm",
    disabled: busy,
    title,
    onClick: () => {
      void setCooldownRelief(!enabled);
    }
  }, label);
}
function UninstallAction({ subject, t: t2 }) {
  useUpdateStore();
  const [confirming, setConfirming] = (0, import_react.useState)(false);
  const timerRef = (0, import_react.useRef)(void 0);
  (0, import_react.useEffect)(() => () => {
    window.clearTimeout(timerRef.current);
  }, []);
  const name2 = subject.kind === "bundle" ? subject.pkg?.name : void 0;
  if (name2 === void 0 || name2 === SELF_PACKAGE) return null;
  const op = snapshot().uninstalls[name2];
  const error = op !== void 0 && typeof op === "object" ? op.error : void 0;
  const integrity = error !== void 0 && error.startsWith("integrity:") ? error.slice("integrity:".length) : void 0;
  const busy = op === "uninstalling";
  const label = busy ? t2("uninstalling") : integrity !== void 0 ? t2("integrityBroken") : error !== void 0 ? t2("uninstallFailed") : confirming ? t2("confirmUninstall") : t2("forceUninstall");
  const onClick = () => {
    if (busy) return;
    if (confirming) {
      window.clearTimeout(timerRef.current);
      setConfirming(false);
      void uninstallPlugin(name2).then((ok) => {
        if (ok) window.location.reload();
      });
      return;
    }
    setConfirming(true);
    timerRef.current = window.setTimeout(() => {
      setConfirming(false);
    }, 5e3);
  };
  const title = integrity !== void 0 ? `${t2("integrityBroken")}: ${integrity}` : error !== void 0 ? `${t2("uninstallFailed")}: ${error}` : confirming ? t2("confirmUninstallHint") : t2("forceUninstallHint");
  const Button = table.Button;
  if (typeof Button !== "function") {
    return (0, import_react.createElement)("button", {
      type: "button",
      disabled: busy,
      title,
      onClick,
      style: { cursor: busy ? "default" : "pointer" }
    }, label);
  }
  return (0, import_react.createElement)(Button, {
    variant: confirming ? "danger" : void 0,
    size: "sm",
    disabled: busy,
    title,
    onClick
  }, label);
}

// src/client/navBadge.ts
var LABELS = /* @__PURE__ */ new Set(["\u63D2\u4EF6", "Plugins"]);
var CSS = `
.dpi-navBadge{flex:none;margin-left:2px;min-width:18px;height:18px;box-sizing:border-box;border-radius:999px;padding:0 5px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:16px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
`;
var count = 0;
var observer = null;
var style = null;
var scheduled = 0;
function paint() {
  document.querySelectorAll("span[data-dpi-badge]").forEach((element) => {
    element.remove();
  });
  if (count <= 0 || observer === null) return;
  for (const label of Array.from(document.querySelectorAll("button span"))) {
    const text = label.textContent?.trim();
    if (text === void 0 || !LABELS.has(text)) continue;
    const cell = label.parentElement;
    if (cell === null || cell.tagName !== "BUTTON") continue;
    const badge = document.createElement("span");
    badge.className = "dpi-navBadge";
    badge.dataset.dpiBadge = "";
    badge.textContent = String(count);
    cell.appendChild(badge);
  }
}
function schedule() {
  window.clearTimeout(scheduled);
  scheduled = window.setTimeout(paint, 150);
}
function installNavBadge() {
  style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  paint();
  return () => {
    window.clearTimeout(scheduled);
    observer?.disconnect();
    observer = null;
    style?.remove();
    style = null;
    document.querySelectorAll("span[data-dpi-badge]").forEach((element) => {
      element.remove();
    });
  };
}
function setNavBadgeCount(value) {
  count = value;
  if (observer !== null) paint();
}

// src/client/rowLayer.ts
var DOT_CLASS = "dpi-updateDot";
var BTN_CLASS = "dpi-updateBtn";
var t = (key) => key;
var CSS2 = `
.${DOT_CLASS}{position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:999px;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1);pointer-events:none}
.${BTN_CLASS}{flex:none;display:inline-flex;align-items:center;min-height:24px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-state-success-primary);background:transparent;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap}
.${BTN_CLASS}:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.${BTN_CLASS}:disabled{opacity:.55;cursor:default}
`;
var observer2 = null;
var style2 = null;
var unsubscribe = null;
var scheduled2 = 0;
function rowControls(row) {
  const head = row.firstElementChild;
  if (!(head instanceof HTMLElement)) return null;
  const icon = head.querySelector(':scope > span[aria-hidden="true"]');
  if (icon === null) return null;
  const switch_ = head.querySelector(':scope [role="switch"]');
  const end = switch_ !== null && switch_.parentElement instanceof HTMLElement ? switch_.parentElement : head.lastElementChild instanceof HTMLElement ? head.lastElementChild : null;
  if (end === null) return null;
  return { icon, end, switch_ };
}
function controlFor(name2) {
  const state2 = snapshot();
  const status = state2.updates[name2];
  const op = state2.ops[name2];
  if (status?.updateAvailable === true) {
    const error = op !== void 0 && typeof op === "object" ? op.error : void 0;
    return {
      label: error !== void 0 ? t("updateFailed") : t("updateBtn"),
      disabled: op === "updating",
      title: error !== void 0 ? `${t("updateFailed")}: ${error}` : "",
      kind: "update"
    };
  }
  if (op === "updating") return { label: t("updating"), disabled: true, title: "", kind: "update" };
  if (op === "updated") {
    if (window.dshDesktop !== void 0) {
      return { label: t("restartTrayLabel"), disabled: true, title: t("restartTrayTitle"), kind: "restart" };
    }
    return { label: t("restartShort"), disabled: false, title: "", kind: "restart" };
  }
  return null;
}
function paintRow(row) {
  const name2 = row.getAttribute("data-plugin-package") ?? "";
  const control = name2 === "" ? null : controlFor(name2);
  row.querySelectorAll(`.${DOT_CLASS}, .${BTN_CLASS}`).forEach((element) => {
    element.remove();
  });
  row.querySelectorAll('span[aria-hidden="true"]').forEach((element) => {
    if (element.style.position === "relative") element.style.position = "";
  });
  const controls = control === null ? null : rowControls(row);
  if (control === null || controls === null) return;
  const hasUpdate = snapshot().updates[name2]?.updateAvailable === true;
  if (hasUpdate) {
    controls.icon.style.position = "relative";
    const dot = document.createElement("span");
    dot.className = DOT_CLASS;
    dot.dataset.dpiFor = name2;
    controls.icon.appendChild(dot);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = BTN_CLASS;
  button.dataset.dpiFor = name2;
  button.textContent = control.label;
  button.disabled = control.disabled;
  if (control.title !== "") button.title = control.title;
  button.addEventListener("click", () => {
    const kind = controlFor(name2)?.kind;
    if (kind === "update") void updatePlugin(name2);
    if (kind === "restart") void restartHost();
  });
  if (controls.switch_ !== null) controls.end.insertBefore(button, controls.switch_);
  else controls.end.appendChild(button);
}
function paint2() {
  document.querySelectorAll("li[data-plugin-package]").forEach(paintRow);
}
function schedule2() {
  window.clearTimeout(scheduled2);
  scheduled2 = window.setTimeout(paint2, 150);
}
function installRowLayer(translate) {
  t = translate;
  style2 = document.createElement("style");
  style2.textContent = CSS2;
  document.head.appendChild(style2);
  observer2 = new MutationObserver(schedule2);
  observer2.observe(document.body, { childList: true, subtree: true });
  unsubscribe = subscribe(schedule2);
  paint2();
  return () => {
    window.clearTimeout(scheduled2);
    observer2?.disconnect();
    observer2 = null;
    unsubscribe?.();
    unsubscribe = null;
    style2?.remove();
    style2 = null;
    document.querySelectorAll(`.${DOT_CLASS}, .${BTN_CLASS}`).forEach((element) => {
      element.remove();
    });
    document.querySelectorAll('li[data-plugin-package] span[aria-hidden="true"]').forEach((element) => {
      if (element.style.position === "relative") element.style.position = "";
    });
  };
}

// src/client/locales.ts
var zh = {
  updateBtn: "\u66F4\u65B0",
  updating: "\u66F4\u65B0\u4E2D\u2026",
  restartShort: "\u91CD\u542F",
  restartTrayLabel: "\u5DF2\u66F4\u65B0\uFF0C\u91CD\u542F\u540E\u751F\u6548",
  restartTrayTitle: "\u8BF7\u901A\u8FC7\u684C\u9762\u5BA2\u6237\u7AEF\u6258\u76D8\u83DC\u5355\u4E2D\u7684\u300C\u91CD\u542F\u670D\u52A1\u300D\u5B8C\u6210\u91CD\u542F",
  updateFailed: "\u66F4\u65B0\u5931\u8D25",
  updateAvailable: "\u6709\u53EF\u7528\u66F4\u65B0",
  newCommits: "\u6709\u65B0\u63D0\u4EA4",
  badgeUpdate: "\u53EF\u66F4\u65B0 {version}",
  forceUninstall: "\u5F3A\u5236\u5378\u8F7D",
  confirmUninstall: "\u786E\u8BA4\u5F3A\u5236\u5378\u8F7D\uFF1F",
  uninstalling: "\u5378\u8F7D\u4E2D\u2026",
  uninstallFailed: "\u5378\u8F7D\u5931\u8D25",
  integrityBroken: "\u4F9D\u8D56\u53D7\u635F",
  reliefEnable: "\u89E3\u9501\u5B98\u65B9\u9875\u9762",
  reliefDisable: "\u6062\u590D\u51B7\u9759\u671F",
  reliefBusy: "\u5207\u6362\u4E2D\u2026",
  reliefHintOff: "\u672C\u63D2\u4EF6\u6863\u6848\u4E2D\u5B58\u5728\u53D1\u5E03\u672A\u6EE1 24 \u5C0F\u65F6\u7684\u7248\u672C\u65F6\uFF0C\u5B98\u65B9\u63D2\u4EF6\u9875\u7684\u6240\u6709\u5B89\u88C5/\u5378\u8F7D\u64CD\u4F5C\u90FD\u4F1A\u88AB pnpm \u7684\u53D1\u5E03\u51B7\u9759\u671F\u5BA1\u8BA1\u62E6\u622A\u3002\u5F00\u542F\u540E\u5411\u672C\u6863\u6848\u5199\u5165 minimumReleaseAge: 0\uFF0C\u5B98\u65B9\u9875\u9762\u7ACB\u5373\u6062\u590D\u53EF\u7528\u3002",
  reliefHintOn: "\u5DF2\u89E3\u9664\u672C\u6863\u6848\u7684\u53D1\u5E03\u51B7\u9759\u671F\u62E6\u622A\uFF08minimumReleaseAge: 0\uFF09\u3002\u70B9\u51FB\u6062\u590D\u9ED8\u8BA4\u7684 24 \u5C0F\u65F6\u4F9B\u5E94\u94FE\u89C2\u5BDF\u671F\u4FDD\u62A4\u3002",
  forceUninstallHint: "\u7ED5\u8FC7\u53D1\u5E03\u51B7\u9759\u671F\u76F4\u63A5\u5378\u8F7D\uFF1B\u5B98\u65B9\u5378\u8F7D\u88AB\u51B7\u9759\u671F\u62E6\u622A\u65F6\u4F7F\u7528",
  confirmUninstallHint: "\u518D\u6B21\u70B9\u51FB\u786E\u8BA4\u5378\u8F7D\uFF0C\u8BE5\u64CD\u4F5C\u4E0D\u53EF\u64A4\u9500"
};
var en = {
  updateBtn: "Update",
  updating: "Updating\u2026",
  restartShort: "Restart",
  restartTrayLabel: "Updated \u2014 restart pending",
  restartTrayTitle: "Restart the client via Restart Service in the desktop tray menu",
  updateFailed: "Update failed",
  updateAvailable: "Update available",
  newCommits: "New commits",
  badgeUpdate: "{version} available",
  forceUninstall: "Force uninstall",
  confirmUninstall: "Confirm force uninstall?",
  uninstalling: "Uninstalling\u2026",
  uninstallFailed: "Uninstall failed",
  integrityBroken: "Dependencies broken",
  reliefEnable: "Unlock official page",
  reliefDisable: "Restore cooldown",
  reliefBusy: "Switching\u2026",
  reliefHintOff: "While this profile holds a version published within the last 24 hours, every official-page plugin operation is refused by the release-cooldown audit of pnpm. Enabling writes minimumReleaseAge: 0 into this profile, restoring the official page at once.",
  reliefHintOn: "Release-cooldown enforcement is disabled for this profile (minimumReleaseAge: 0). Click to restore the default 24-hour supply-chain hold.",
  forceUninstallHint: "Remove directly, bypassing the publish cooldown \u2014 for when the official uninstall is blocked by it",
  confirmUninstallHint: "Click again to confirm; this cannot be undone"
};

// src/client/index.ts
var NS = "settings.pluginInstall";
var name = "dsh-plugin-install";
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-plugin-install: dictionaries");
  const t2 = ctx.locale.bind(NS);
  ctx.effect(() => installRowLayer(t2), "dsh-plugin-install: row layer");
  ctx.effect(() => installNavBadge(), "dsh-plugin-install: nav badge");
  ctx.effect(() => subscribe(() => {
    setNavBadgeCount(updateCount());
  }), "dsh-plugin-install: badge mirror");
  ctx.effect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10 * 6e4);
    return () => clearInterval(timer);
  }, "dsh-plugin-install: refresh cadence");
  ctx.slots.inject("plugins.detail.badge", () => {
    ctx.slots.register({
      name: "plugins.detail.badge",
      id: "update-badge",
      order: 20,
      label: () => t2("updateAvailable"),
      locale: NS
    }, UpdateBadge);
  });
  ctx.slots.inject("plugins.detail.actions", () => {
    ctx.slots.register({
      name: "plugins.detail.actions",
      id: "update-action",
      order: 20,
      label: () => t2("updateBtn"),
      locale: NS
    }, UpdateAction);
  });
  ctx.slots.inject("plugins.detail.actions", () => {
    ctx.slots.register({
      name: "plugins.detail.actions",
      id: "uninstall-action",
      order: 21,
      label: () => t2("forceUninstall"),
      locale: NS
    }, UninstallAction);
  });
  ctx.slots.inject("plugins.detail.actions", () => {
    ctx.slots.register({
      name: "plugins.detail.actions",
      id: "cooldown-relief-action",
      order: 22,
      label: () => t2("reliefEnable"),
      locale: NS
    }, CooldownReliefAction);
  });
}

return module.exports; } });
//# sourceMappingURL=client.js.map
