// 検証ホストの画面。会話・作品一覧・プレビュー・3 表示モード・候補の保存と復元。
import { clog } from "/client-log.js";
import { PreviewController, PreviewConnectError, PAGE_WARNING, isChromium, isWebKitOnly, pageRefusal } from "/preview-client.js";

const $ = (id) => document.getElementById(id);
const cfg = await (await fetch("/api/config")).json();
clog("config", { previewOrigin: cfg.previewOrigin, hostOrigin: cfg.hostOrigin, pageOrigin: location.origin });

function rid(n = 12) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// 制作画面ごとの session（タブごと）
// 試験では ?clock=manual で時計をホストから進める
const CLOCK = new URLSearchParams(location.search).get("clock") === "manual" ? "manual" : "raf";
// 直接描画は実時間の時計で、設定が有効で、WebKit だけのブラウザでないときだけ（WebKit では Worker から描いた内容が表示に出ないことがある）
const WEBKIT_ONLY = isWebKitOnly(navigator.userAgent);
const DIRECT = CLOCK === "raf" && cfg.directRender === true && !WEBKIT_ONLY;
// ページ直接モード（design.md §8）は設定が有効で、Chromium 系のブラウザのときだけ開く。
const PAGE_MODE = cfg.pageMode === true;
const session = sessionStorage.getItem("canvas-session") || rid();
sessionStorage.setItem("canvas-session", session);

const state = {
  artworkId: null,
  currentRevision: 0,
  conversation: [],
  runId: null,
  candidate: null,
  saveKey: null,
  previewSource: null,
  mode: "frame",
  returnFocus: null,
};
let selection = 0;
let artworkRequest = 0;
let listRequest = 0;
let previewRequest;
let restoreAttempt;

// quiet: 定期の状態確認など。成功は記録せず、失敗だけ残す
async function api(path, { method = "GET", body, quiet = false } = {}) {
  const t0 = performance.now();
  if (!quiet) clog("api.start", { method, path });
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: { "content-type": "application/json", "x-canvas-session": session },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    clog("api.end", { method, path, status: 0, ms: Math.round(performance.now() - t0), error: err });
    throw err;
  }
  const j = await r.json().catch(() => ({}));
  if (!quiet || !r.ok) clog("api.end", { method, path, status: r.status, ms: Math.round(performance.now() - t0), error: r.ok ? undefined : j.error || r.statusText });
  if (!r.ok) {
    const e = new Error(j.error || r.statusText);
    e.status = r.status;
    e.info = j;
    throw e;
  }
  return j;
}

const host = $("preview-host");
const frame = $("preview-frame");
const ctl = new PreviewController(frame, {
  previewOrigin: cfg.previewOrigin,
  onEvent: (m) => {
    if (m.type === "error" || m.type === "violation") clog("preview.event", { kind: m.type, message: m.message });
    if (m.type === "error") notice("作品のエラー: " + m.message);
    if (m.type === "violation") notice("作品を停止しました（" + m.message + "）");
    if (m.type === "error" || m.type === "violation") frame.setAttribute("aria-label", "作品プレビュー");
    if (m.type === "escape") exitMode();
  },
  onConnection: (st, err) => showConnection(st, err),
});
window.__canvasHost = { ctl, state }; // 試験での観測用（読み取りのみ）

function notice(t) {
  $("notice").textContent = t;
}

// ---- プレビューの接続状態 ----
// 接続はホスト画面の操作と切り離して進める。失敗しても送信・保存は使える。
function connectFailureText(err) {
  const origin = err?.previewOrigin || cfg.previewOrigin;
  const sec = Math.round((err?.timeoutMs ?? ctl.connectTimeoutMs) / 1000);
  const hostName = new URL(origin).hostname;
  return (
    `プレビュー（${origin}）に接続できません。${sec} 秒以内に応答がありませんでした。` +
    `依頼の送信と保存はこのまま使えますが、作品は表示できません。` +
    `考えられる原因: ブラウザが別サイトの ${hostName} の埋め込みを遮断している（シールド・広告ブロック・ローカルネットワークへのアクセス許可）、` +
    `プレビューのポートがサーバーの設定と違う、サーバーを起動し直す前に開いた古いタブ。`
  );
}

function showConnection(st, err) {
  document.body.dataset.preview = st;
  clog("preview.connection", { state: st, code: err?.code, timeoutMs: err?.timeoutMs, previewOrigin: cfg.previewOrigin });
  const box = $("preview-error");
  if (st === "failed") {
    $("preview-error-text").textContent = connectFailureText(err);
    $("preview-retry").disabled = false;
    box.hidden = false;
    console.error("[canvas] " + connectFailureText(err), err);
  } else if (st === "connecting") {
    $("preview-retry").disabled = true;
  } else {
    box.hidden = true;
  }
}

$("preview-retry").addEventListener("click", async () => {
  const request = previewRequest;
  try {
    await ctl.reconnect();
  } catch {
    return; // 失敗の表示は showConnection が出す
  }
  if (request === previewRequest && state.previewSource) await showPreview(state.previewSource, $("preview-label").textContent);
});

// ---- 表示モード ----
function setMode(mode) {
  state.mode = mode;
  host.classList.remove("mode-frame", "mode-fill", "mode-fullscreen");
  host.classList.add("mode-" + mode);
  for (const b of host.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
}

async function enterMode(mode, trigger) {
  if (mode === state.mode) return;
  if (state.mode === "frame") state.returnFocus = trigger || document.activeElement;
  if (mode === "fullscreen") {
    if (!document.fullscreenEnabled || !host.requestFullscreen) {
      notice("全画面を使えないため、ブラウザ全面で表示しています");
      setMode("fill");
      return;
    }
    try {
      await host.requestFullscreen();
      setMode("fullscreen");
    } catch {
      notice("全画面を拒否されたため、ブラウザ全面で表示しています");
      setMode("fill");
    }
    return;
  }
  if (state.mode === "fullscreen" && document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  setMode(mode);
  if (mode === "frame") restoreFocus();
}

function restoreFocus() {
  const el = state.returnFocus;
  state.returnFocus = null;
  if (el && document.contains(el)) el.focus();
}

async function exitMode() {
  if (state.mode === "fullscreen" && document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
    return; // fullscreenchange で戻す
  }
  if (state.mode !== "frame") {
    setMode("frame");
    restoreFocus();
  }
}

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && state.mode === "fullscreen") {
    setMode("frame");
    restoreFocus();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.mode !== "frame") exitMode();
});
for (const b of host.querySelectorAll("[data-mode]")) b.addEventListener("click", () => enterMode(b.dataset.mode, b));
$("exit-mode").addEventListener("click", exitMode);

// ---- プレビュー ----
async function showPreview(source, label) {
  previewRequest?.abort();
  const request = new AbortController();
  previewRequest = request;
  frame.setAttribute("aria-label", "作品プレビュー");
  state.previewSource = source;
  host.dataset.ready = "0";
  $("preview-label").textContent = label;
  const warn = $("page-warning");
  warn.hidden = true;
  warn.textContent = "";
  let p;
  try {
    p = await api("/api/previews", { method: "POST", body: source });
  } catch (err) {
    if (!request.signal.aborted) notice("プレビューを準備できませんでした: " + err.message);
    return;
  }
  if (request.signal.aborted) return;
  const page = p.runtime === "page";
  if (page) {
    warn.hidden = false;
    const refuse = pageRefusal({ pageMode: PAGE_MODE, chromium: isChromium(navigator.userAgent) });
    if (refuse) {
      warn.textContent = refuse;
      host.dataset.ready = "0";
      clog("preview.start", { result: "page-refused", label });
      return { type: "page-refused", message: refuse };
    }
    warn.textContent = PAGE_WARNING;
  }
  let r;
  try {
    // 実際の利用（raf）では起動のたびに別の乱数列にする。固定の 1 だと api.random() が毎回同じ展開になるため。manual（試験・観測）は 1 のまま
    const seed = CLOCK === "raf" ? crypto.getRandomValues(new Uint32Array(1))[0] : 1;
    r = await ctl.start({ token: p.token, data: p.data, seed, clock: CLOCK, direct: DIRECT && !page, signal: request.signal, ...(page ? { runtime: "page" } : {}) });
  } catch (err) {
    if (request.signal.aborted) return;
    if (!(err instanceof PreviewConnectError)) throw err;
    host.dataset.ready = "0";
    notice("プレビューに接続できないため表示できません。上の「再接続」を試してください。");
    clog("preview.start", { result: "connect-failed", label });
    return { type: "connect-failed", message: err.message };
  }
  if (request.signal.aborted) return;
  clog("preview.start", { result: r.type, message: r.message, label });
  host.dataset.ready = r.type === "ready" ? "1" : "0";
  if (r.type === "ready") frame.setAttribute("aria-label", `${label}のプレビュー表示中`);
  if (r.type !== "ready") notice("起動できませんでした: " + (r.message || r.type));
  return r;
}
function stopPreview() {
  previewRequest?.abort();
  previewRequest = undefined;
  host.dataset.ready = "0";
  frame.setAttribute("aria-label", "作品プレビュー");
  ctl.stop().catch(() => {});
}
$("stop").addEventListener("click", stopPreview);
$("restart").addEventListener("click", () => state.previewSource && showPreview(state.previewSource, $("preview-label").textContent));

// ---- 会話 ----
function addMessage(role, text) {
  const li = document.createElement("li");
  li.className = role;
  li.textContent = text;
  $("messages").appendChild(li);
  li.scrollIntoView({ block: "end" });
}

function setRunStatus(t) {
  $("run-status").textContent = t;
}

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("message");
  const draft = input.value;
  const text = draft.trim();
  clog("ui.submit", { length: text.length });
  const send = $("send");
  if (!text || send.disabled) return;
  const selected = selection;
  send.disabled = true;
  input.value = "";
  addMessage("user", text);
  let run;
  try {
    run = await api("/api/runs", { method: "POST", body: { message: text, artworkId: state.artworkId, conversation: state.conversation } });
  } catch (err) {
    if (selected !== selection) return;
    if (input.value === "") input.value = draft;
    setRunStatus("受け付けられませんでした");
    addMessage("assistant", "受け付けられませんでした: " + err.message);
    return;
  } finally {
    if (selected === selection) send.disabled = false;
  }
  if (selected !== selection) return;
  hideCandidate();
  state.conversation.push({ role: "user", text });
  state.runId = run.id;
  clog("run.state", { runId: run.id, state: run.state, attempts: run.attempts });
  $("cancel").disabled = false;
  setRunStatus("生成中…");
  pollRun(run.id);
});

$("message").addEventListener("keydown", (e) => {
  if (e.key === "Enter") clog("ui.enter", { meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, composing: e.isComposing });
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("composer").requestSubmit();
});

$("cancel").addEventListener("click", async () => {
  if (!state.runId) return;
  await api(`/api/runs/${state.runId}/cancel`, { method: "POST", body: {} }).catch(() => {});
});

const STATE_TEXT = { failed: "失敗しました", cancelled: "取り消しました", expired: "期限を過ぎました", superseded: "新しい依頼に置き換えました" };

async function pollRun(id) {
  let last = "running";
  let lastAttempts = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    if (state.runId !== id) return;
    let run;
    try {
      run = await api(`/api/runs/${id}`, { quiet: true });
    } catch {
      continue;
    }
    if (state.runId !== id) return;
    if (run.state !== last || run.attempts !== lastAttempts) {
      clog("run.state", { runId: id, state: run.state, attempts: run.attempts, failureHead: run.failure ? run.failure.split(":")[0].slice(0, 80) : undefined }); // 失敗の詳細は依頼の一部を含みうるため、見出しだけ
      last = run.state;
      lastAttempts = run.attempts;
    }
    if (run.state === "running") {
      setRunStatus(`生成中…（試行 ${run.attempts}）`);
      continue;
    }
    $("cancel").disabled = true;
    state.runId = null;
    if (run.state === "presented") {
      const c = run.candidates.find((x) => x.id === run.presentedCandidateId);
      setRunStatus(`候補を提示（試行 ${run.attempts}）`);
      addMessage("assistant", c.reply || "候補を作りました。");
      state.conversation.push({ role: "assistant", text: c.reply || "候補を作りました。" });
      showCandidate(c, run);
      await showPreview({ candidateId: c.id }, "候補");
    } else {
      // 契約違反・起動不能・取消のときは最後に開けた版を表示し続ける
      setRunStatus(STATE_TEXT[run.state] || run.state);
      addMessage("assistant", (STATE_TEXT[run.state] || run.state) + (run.failure ? `: ${run.failure}` : ""));
    }
    return;
  }
}

// ---- 候補・保存 ----
function hideCandidate() {
  $("candidate").hidden = true;
  state.candidate = null;
}

const REQUIRED_LEVELS = ["contract", "loaded", "operated"];
const VERDICT_TEXT = { pass: "確認した", fail: "満たしていない", unknown: "未確認" };
const SEVERITY_TEXT = { blocking: "[要修正]", warning: "[注意]", info: "[参考]" };

function addLine(ul, className, text) {
  const li = document.createElement("li");
  li.className = className;
  li.textContent = text; // 制作担当・検証担当の文をそのまま出すため textContent
  ul.appendChild(li);
}

/** 候補の検証の結果（宣言・判定・指摘）。検証していない候補は隠す。 */
function showReview(c, run) {
  const r = c.review;
  $("cand-review").hidden = !r;
  const reqs = $("cand-requirements");
  const finds = $("cand-findings");
  reqs.textContent = "";
  finds.textContent = "";
  if (!r) return;
  $("cand-review-head").textContent = (r.mode === "replay" && !r.verdict
    ? (r.replay?.phase === "repair" ? "修正後の操作を再生・要件の合否は未確認" : "要件の合否は未確認")
    : `検証（${r.mode}）：要修正 ${r.blocking} 件`) + (r.error ? `／検証の一部が失敗：${r.error}` : "");
  const requirements = c.spec?.requirements ?? [];
  if (r.verdict) {
    for (const v of r.verdict.verdicts) {
      const q = requirements.find((x) => x.id === v.requirement);
      if (!q) continue;
      addLine(reqs, v.verdict, `${q.id} ${q.text} — ${VERDICT_TEXT[v.verdict] ?? "未確認"}${v.note ? "：" + v.note : ""}`);
    }
  } else for (const q of requirements) addLine(reqs, "unknown", `${q.id} ${q.text} — 未確認`);
  for (const f of r.findings) addLine(finds, f.severity, `${SEVERITY_TEXT[f.severity] ?? "[参考]"} ${f.message}`);
  if (r.replay) {
    const initial = r.replay.phase === "repair" ? run.candidates.find((candidate) => candidate.review?.replay?.phase === "initial")?.review.replay : null;
    for (const record of [initial, r.replay]) {
      if (!record) continue;
      const label = record.phase === "repair" ? "修正後" : (initial ? "修正前" : "操作の再生");
      for (const result of record.results) {
        if (result.skipped) addLine(finds, "info", `${label} — ${result.skipped}`);
        for (const m of result.measures) addLine(finds, "info", `${label}・${m.t}ms・${m.label} — ${m.text}`);
      }
    }
  }
}

function showCandidate(c, run) {
  state.candidate = { ...c, baseRevision: run.baseRevision };
  state.saveKey = rid();
  $("candidate").hidden = false;
  $("cand-title").textContent = c.title;
  $("cand-digest").textContent = c.digest.slice(0, 19) + "…";
  $("cand-changes").textContent = c.changes;
  const ul = $("cand-checks");
  ul.textContent = "";
  // 必須の検査だけを出す（matched・advisory の助言を「不合格」と並べると、保存できない候補に見える）
  for (const k of (c.verification?.checks ?? []).filter((k) => REQUIRED_LEVELS.includes(k.level))) {
    const li = document.createElement("li");
    li.className = k.pass ? "pass" : "fail";
    li.textContent = `${k.level}: ${k.id} ${k.pass ? "合格" : "不合格"}${k.detail ? "（" + k.detail + "）" : ""}`;
    ul.appendChild(li);
  }
  showReview(c, run);
  $("cand-unconfirmed").textContent = c.unconfirmed.length ? "未確認: " + c.unconfirmed.join(" / ") : "未確認: 依頼に沿うかの照合（自動では確定しない）";
  $("save-status").textContent = "";
  $("save").disabled = !c.verification?.requiredPassed;
}

$("save").addEventListener("click", async () => {
  const c = state.candidate;
  if (!c) return;
  const selected = selection;
  $("save").disabled = true;
  let saved;
  try {
    saved = await commitRevision(`/api/candidates/${c.id}/save`, { expectedRevision: c.baseRevision, idempotencyKey: state.saveKey });
  } catch (err) {
    if (selected !== selection || state.candidate !== c) return;
    if (err.info?.code === "conflict") $("save-status").textContent = `競合: 現在版は r${err.info.currentRevision}。候補は残っています。現在版を開いて確認してください。`;
    else $("save-status").textContent = commitFailure("保存", err);
    $("save").disabled = false;
    return;
  }
  void refreshArtworks();
  if (selected !== selection || state.candidate !== c) return;
  showCommittedRevision(saved.artworkId, saved.revision, c.title);
  $("save-status").textContent = `保存しました（r${saved.revision}）`;
  await refreshRevisions(saved.artworkId);
});

async function commitRevision(path, body) {
  const result = await api(path, { method: "POST", body });
  if (typeof result?.artworkId !== "string" || !Number.isSafeInteger(result.revision) || result.revision < 1) {
    throw new Error("版の受領結果がありません");
  }
  return result;
}

function commitFailure(action, err) {
  if (!err.status || err.status >= 500) return `${action}結果を確認できませんでした。同じ操作で結果を確認できます。`;
  return `${action}できませんでした: ${err.message}`;
}

// ---- 作品一覧・版 ----
async function refreshArtworks() {
  const request = ++listRequest;
  const status = $("artworks-status");
  let list;
  try {
    list = await api("/api/artworks");
    if (!Array.isArray(list)) throw new Error("作品一覧の形式が違います");
  } catch {
    if (request === listRequest) status.textContent = "作品一覧を取得できませんでした。作品情報を再取得できます。";
    return;
  }
  if (request !== listRequest) return;
  const ul = $("artworks");
  const focusedId = ul.contains(document.activeElement) ? document.activeElement.dataset.artworkId : null;
  ul.textContent = "";
  let focus;
  for (const a of list) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = `${a.title}（r${a.currentRevision}）`;
    b.dataset.artworkId = a.id;
    b.addEventListener("click", () => openArtwork(a.id));
    if (focusedId === a.id) focus = b;
    li.appendChild(b);
    ul.appendChild(li);
  }
  markSelectedArtwork();
  if (focusedId) (focus ?? $("refresh-artworks")).focus();
  status.textContent = "";
}

function markSelectedArtwork() {
  for (const button of $("artworks").querySelectorAll("button[data-artwork-id]")) {
    const active = button.dataset.artworkId === state.artworkId;
    button.parentElement.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function setCurrentRevision(id, revision, title) {
  state.artworkId = id;
  state.currentRevision = revision;
  $("current").textContent = `${title}（現在 r${revision}）`;
  markSelectedArtwork();
}

function showCommittedRevision(id, revision, title) {
  if (state.artworkId === id && state.currentRevision > revision) return;
  setCurrentRevision(id, revision, title);
}

async function loadArtwork(id) {
  const selected = selection;
  const request = ++artworkRequest;
  let a;
  try {
    a = await api(`/api/artworks/${id}`);
  } catch (err) {
    if (selected !== selection || request !== artworkRequest) return;
    throw err;
  }
  if (selected !== selection || request !== artworkRequest) return;
  setCurrentRevision(a.id, a.currentRevision, a.title);
  const ol = $("revisions");
  ol.textContent = "";
  for (const r of [...a.revisions].reverse()) {
    const li = document.createElement("li");
    li.dataset.revision = String(r.revision);
    li.append(`r${r.revision}${r.restoredFrom ? `（r${r.restoredFrom} から復元）` : ""} `);
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "表示";
    open.addEventListener("click", () => showPreview({ artworkId: a.id, revision: r.revision }, `保存版 r${r.revision}`));
    li.appendChild(open);
    if (r.revision !== a.currentRevision) {
      const rs = document.createElement("button");
      rs.type = "button";
      rs.textContent = "この版を復元";
      rs.addEventListener("click", () => restore(a.id, r.revision, r.title));
      li.appendChild(rs);
    }
    ol.appendChild(li);
  }
  $("revisions-status").textContent = "";
  return a;
}

async function refreshRevisions(id) {
  const selected = selection;
  try {
    await loadArtwork(id);
  } catch {
    if (selected === selection) $("revisions-status").textContent = "版の履歴を取得できませんでした。作品情報を再取得できます。";
  }
}

$("refresh-artworks").addEventListener("click", () => {
  void refreshArtworks();
  if (state.artworkId) void refreshRevisions(state.artworkId);
});

function selectArtwork(id) {
  const selected = ++selection;
  if (!id || state.artworkId !== id) {
    state.conversation = [];
    $("messages").textContent = "";
  }
  state.artworkId = null;
  state.currentRevision = 0;
  state.runId = null;
  state.previewSource = null;
  restoreAttempt = undefined;
  $("send").disabled = !!id;
  $("cancel").disabled = true;
  setRunStatus("");
  $("restore-status").textContent = "";
  $("revisions-status").textContent = "";
  $("revisions").textContent = "";
  $("current").textContent = id ? "作品を読み込み中…" : "新規の作品";
  $("preview-label").textContent = "";
  $("page-warning").hidden = true;
  notice("");
  hideCandidate();
  markSelectedArtwork();
  stopPreview();
  return selected;
}

async function openArtwork(id) {
  const selected = selectArtwork(id);
  try {
    const a = await loadArtwork(id);
    if (selected !== selection || !a) return;
    $("send").disabled = false;
    await showPreview({ artworkId: a.id }, `保存版 r${a.currentRevision}`);
  } catch (err) {
    if (selected !== selection) return;
    selectArtwork(null);
    notice("作品を開けませんでした: " + err.message);
  }
}

async function restore(id, revision, title) {
  const selected = selection;
  if (restoreAttempt?.inFlight) return;
  if (restoreAttempt?.id !== id || restoreAttempt.body.revision !== revision) {
    restoreAttempt = { id, body: { revision, expectedRevision: state.currentRevision, idempotencyKey: rid() }, inFlight: false };
  }
  const attempt = restoreAttempt;
  attempt.inFlight = true;
  const status = $("restore-status");
  let restored;
  try {
    restored = await commitRevision(`/api/artworks/${id}/restore`, attempt.body);
  } catch (err) {
    if (selected === selection) {
      if (err.status && err.status < 500) restoreAttempt = undefined;
      status.textContent = commitFailure("復元", err);
    }
    return;
  } finally {
    attempt.inFlight = false;
  }
  void refreshArtworks();
  if (selected !== selection) return;
  restoreAttempt = undefined;
  showCommittedRevision(id, restored.revision, title);
  status.textContent = `r${revision} を r${restored.revision} として復元しました`;
  void refreshRevisions(id);
  await showPreview({ artworkId: id, revision: restored.revision }, `保存版 r${restored.revision}`).catch((err) => {
    if (selected === selection) notice("復元した版を表示できませんでした: " + err.message);
  });
}

$("new-artwork").addEventListener("click", () => {
  selectArtwork(null);
});

// 操作をすべて登録してから接続を始める。接続の成否を待たずに画面を使えるようにする。
ctl.mount().catch(() => {});
await refreshArtworks();
document.body.dataset.ready = "1";
clog("page.ready");
