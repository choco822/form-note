"use strict";
const AN = window.Analysis;
const $ = (id) => document.getElementById(id);
const isNum = AN.isNum;
const fmt = (v, d = 0) => (isNum(v) ? v.toFixed(d) : "—");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer = null;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
const pref = {
  get(k, d) { try { const v = localStorage.getItem("fan:" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("fan:" + k, JSON.stringify(v)); } catch (e) { /* 使えなくても動く */ } },
};

// ===================== タブ =====================
const TABS = ["analyze", "compare", "records", "speed"];
function showTab(name) {
  for (const t of TABS) { $("tab-" + t).hidden = t !== name; $("t-" + t).setAttribute("aria-selected", String(t === name)); }
  pref.set("tab", name);
  if (name === "records") renderRecords();
  if (name === "compare") fillCompareOptions();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ===================== チームの記録（Firebase・仮バージョン：全員で共有） =====================
const Store = {
  me: null, users: [], data: { swings: [], speeds: [] }, listeners: [],
  isStaff() { return true; }, // 仮バージョンでは全員が全部の記録を扱える
  start(uid) {
    this.me = { uid, name: "", role: "staff" };
    FB.watchRecords((docs) => {
      this.data.swings = docs.filter((d) => d.kind === "swing");
      this.data.speeds = docs.filter((d) => d.kind === "speed");
      this.emit();
    }, () => toast("記録を読み込めませんでした。通信状態を確認してください"));
    FB.watchPlayers((ps) => {
      this.users = ps.sort((x, y) => (x.name || "").localeCompare(y.name || "", "ja"));
      fillPlayerSelects(); this.emit();
    }, () => toast("名簿を読み込めませんでした"));
  },
  onChange(fn) { this.listeners.push(fn); },
  emit() { this.listeners.forEach((f) => f()); },
  nameOf(uid) { const u = this.users.find((x) => x.uid === uid); return u ? u.name : ""; },
  async add(col, doc) {
    if (!doc.playerUid || !doc.player) throw Object.assign(new Error("no player"), { code: "no-player" });
    doc.kind = col === "swings" ? "swing" : "speed";
    doc.createdAt = new Date().toISOString();
    doc.createdBy = this.me.uid;
    await FB.addRecord(doc);
  },
  async remove(col, id) { await FB.deleteRecord(id); },
};
function fillPlayerSelects() {
  const opts = Store.users.length ? Store.users.map((u) => `<option value="${esc(u.uid)}">${esc(u.name || "名前なし")}</option>`).join("") : `<option value="">（名簿が空です。「記録」画面で追加）</option>`;
  for (const id of ["playerSel", "spPlayerSel"]) {
    const el = $(id); if (!el) continue;
    const cur = el.value; el.innerHTML = opts; el.disabled = !Store.users.length;
    if (Store.users.some((u) => u.uid === cur)) el.value = cur;
    else { const last = pref.get("playerUid", ""); if (Store.users.some((u) => u.uid === last)) el.value = last; }
  }
}

// ===================== AIモデル（YOLO姿勢推定をTF.jsで） =====================
// AIに入れる画像の大きさ。選手のまわりを切り取ってから入れるので、小さめでも選手は大きく写る
const NET = 384;
const models = {};
async function loadModel(kind, onProgress) {
  if (models[kind]) return models[kind];
  try { await tf.setBackend("webgl"); } catch (e) { await tf.setBackend("cpu"); }
  await tf.ready();
  tf.enableProdMode();
  const m = await tf.loadGraphModel(`pose_${kind}/model.json`, { onProgress });
  tf.tidy(() => { m.execute(tf.zeros([1, NET, NET, 3])); });
  models[kind] = m;
  return m;
}
// 他のアプリに切り替えると、スマホがGPU（AIの計算に使う部分）を取り上げることがある。そのときは作り直して続ける
async function recoverModel(kind) {
  delete models[kind];
  try {
    const name = tf.getBackend();
    const factory = tf.findBackendFactory(name);
    if (factory) { tf.removeBackend(name); tf.registerBackend(name, factory); }
  } catch (e) { /* 作り直せなくても下で読み込み直す */ }
  return loadModel(kind, () => {});
}
// GPUを取り上げられていないか（取り上げられると、計算結果がすべて0になってしまう）
function gpuLost() {
  try { return tf.getBackend() === "webgl" && tf.backend().gpgpu.gl.isContextLost(); } catch (e) { return false; }
}
// 画面が見えるようになるまで待つ（他のアプリに切り替えている間は解析を止めておく）
function waitVisible() {
  if (!document.hidden) return Promise.resolve(0);
  const t0 = performance.now();
  return new Promise((res) => {
    const on = () => { if (!document.hidden) { document.removeEventListener("visibilitychange", on); setTimeout(() => res(performance.now() - t0), 300); } };
    document.addEventListener("visibilitychange", on);
  });
}
const mkCanvas = () => { const c = document.createElement("canvas"); c.width = NET; c.height = NET; return c; };
const lbFull = mkCanvas(), lbCrop = mkCanvas();
// 動画のコマをAI用の正方形に描く。roi（選手のまわり）があればそこを拡大、なければ全体を縮小
function drawNet(cv, source, W, H, roi, rot = 0) {
  const ctx = cv.getContext("2d");
  let s, left, top;
  if (roi) { s = NET / roi.side; left = -(roi.cx - roi.side / 2) * s; top = -(roi.cy - roi.side / 2) * s; }
  else { s = NET / Math.max(W, H); left = Math.floor((NET - W * s) / 2); top = Math.floor((NET - H * s) / 2); }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "rgb(114,114,114)"; ctx.fillRect(0, 0, NET, NET);
  ctx.setTransform(s, 0, 0, s, left, top);
  if (rot && window.Frames) Frames.drawRotated(ctx, source, W, H, rot); else ctx.drawImage(source, 0, 0, W, H);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { cv, s, left, top };
}
// 追いかけている選手のまわりの正方形（動画の座標）。見失っているときは null（全体を見る）
function roiFor(track, W, H) {
  if (!track.prev || !track.h || track.lost > 0) return null;
  const side = Math.max(1.6 * track.h, 1.4 * (track.w || 0));
  if (side > 0.9 * Math.max(W, H)) return null;
  return { cx: track.prev[0], cy: track.prev[1], side };
}
// 描いたAI用の画像から、映っている人の枠と17か所の関節（動画の座標）を返す
async function runNet(model, g) {
  const K = 30, { s, left, top } = g;
  const [vals, cols] = tf.tidy(() => {
    const x = tf.browser.fromPixels(g.cv).toFloat().div(255).expandDims(0);
    const r = model.execute(x).squeeze([0]);
    const conf = r.slice([4, 0], [1, -1]).squeeze([0]);
    const tp = tf.topk(conf, K);
    return [tp.values, tf.gather(r, tp.indices, 1)];
  });
  const v = await vals.data(), c = await cols.data();
  vals.dispose(); cols.dispose();
  const cand = [];
  for (let j = 0; j < K; j++) {
    if (v[j] < 0.25) continue;
    const gg = (row) => c[row * K + j];
    const box = [(gg(0) - left) / s, (gg(1) - top) / s, gg(2) / s, gg(3) / s];
    const xy = [], cf = [];
    for (let k = 0; k < 17; k++) { xy.push([(gg(5 + 3 * k) - left) / s, (gg(6 + 3 * k) - top) / s]); cf.push(gg(7 + 3 * k)); }
    cand.push({ conf: v[j], box, xy, cf });
  }
  const iou = (a, b) => {
    const ax1 = a[0] - a[2] / 2, ay1 = a[1] - a[3] / 2, ax2 = a[0] + a[2] / 2, ay2 = a[1] + a[3] / 2;
    const bx1 = b[0] - b[2] / 2, by1 = b[1] - b[3] / 2, bx2 = b[0] + b[2] / 2, by2 = b[1] + b[3] / 2;
    const iw = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)), ih = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const inter = iw * ih; return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9);
  };
  const kept = [];
  for (const p of cand.sort((a, b) => b.conf - a.conf)) if (kept.every((q) => iou(p.box, q.box) < 0.6)) kept.push(p);
  return kept;
}
// 1コマ全体を見る（最初のコマ・選手選び用）
async function inferFrame(model, source, W, H) { return runNet(model, drawNet(lbFull, source, W, H, null)); }

// ===================== 動画まわり =====================
function seek(video, t) {
  return new Promise((res) => {
    let done = false;
    const fin = () => { if (done) return; done = true; video.removeEventListener("seeked", fin); res(); };
    video.addEventListener("seeked", fin);
    video.currentTime = Math.max(0, Math.min(t, (video.duration || t) - 0.001));
    setTimeout(fin, 4000);
  });
}
async function waitMeta(video) {
  await new Promise((res, rej) => {
    if (video.readyState >= 2) return res();
    const ok = () => { cleanup(); res(); }, ng = () => { cleanup(); rej(new Error("動画を読み込めませんでした")); };
    const cleanup = () => { video.removeEventListener("loadeddata", ok); video.removeEventListener("error", ng); };
    video.addEventListener("loadeddata", ok); video.addEventListener("error", ng);
  });
  // アプリ内カメラで撮った動画（webm）は長さが記録されていないことがあるので、末尾まで飛んで長さを確定させる
  if (!Number.isFinite(video.duration)) {
    await new Promise((res) => {
      const done = () => { video.removeEventListener("durationchange", chk); res(); };
      const chk = () => { if (Number.isFinite(video.duration)) done(); };
      video.addEventListener("durationchange", chk);
      video.currentTime = 1e7; setTimeout(done, 5000);
    });
    await seek(video, 0);
  }
}
// 少しだけ再生して、コマとコマの時間差からfpsを推定する
async function detectFps(video) {
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return null;
  const times = [];
  await seek(video, 0);
  const result = await new Promise((res) => {
    let finished = false;
    const finish = () => {
      if (finished) return; finished = true; video.pause();
      const d = []; for (let i = 1; i < times.length; i++) { const x = times[i] - times[i - 1]; if (x > 0.0015) d.push(x); }
      if (d.length < 5) return res(null);
      d.sort((a, b) => a - b);
      const low = d.slice(0, Math.max(3, Math.floor(d.length / 3)));
      let fps = 1 / AN.nanMedian(low);
      const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 119.88, 120, 240, 480];
      const near = common.find((c) => Math.abs(c - fps) / c < 0.04);
      res(near ? Math.round(near * 100) / 100 : Math.round(fps));
    };
    const cb = (now, md) => { times.push(md.mediaTime); if (times.length < 30 && !finished) video.requestVideoFrameCallback(cb); else finish(); };
    video.requestVideoFrameCallback(cb);
    video.muted = true; video.playbackRate = 1;
    video.play().catch(() => finish());
    setTimeout(finish, 3000);
  });
  await seek(video, 0);
  return result;
}
// object-fit: contain で表示されている動画の範囲
function containRect(cw, ch, vw, vh) {
  const s = Math.min(cw / vw, ch / vh); const w = vw * s, h = vh * s;
  return { x: (cw - w) / 2, y: (ch - h) / 2, s };
}
function sizeCanvas(cv) {
  const r = cv.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w, h, dpr };
}
function drawSkeleton(ctx, xy, cf, map, color, lw, minConf = 0.5) {
  ctx.lineWidth = lw; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = "round";
  for (const [a, b] of AN.SKELETON) {
    if (cf[a] < minConf || cf[b] < minConf) continue;
    const p = map(xy[a]), q = map(xy[b]);
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
  }
  for (const k of [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
    if (cf[k] < minConf) continue; const p = map(xy[k]);
    ctx.beginPath(); ctx.arc(p[0], p[1], lw * 0.9, 0, Math.PI * 2); ctx.fill();
  }
}

// ===================== 解析の状態 =====================
const S = {
  file: null, url: null, W: 0, H: 0, duration: 0, fileFps: 30, realFps: 30, target: null,
  k0: 0, stride: 1, F: [], KP: [], A: null, dir: 1, events: [], selected: 0, running: false, cancel: false,
};
const video = $("video"), overlay = $("overlay");

function updateHandLabels() {
  const bat = $("modeBat").checked;
  $("handRLabel").textContent = bat ? "右打ち" : "右投げ";
  $("handLLabel").textContent = bat ? "左打ち" : "左投げ";
  pref.set("mode", bat ? "batting" : "pitching");
}
$("modeBat").addEventListener("change", updateHandLabels);
$("modePitch").addEventListener("change", updateHandLabels);
$("handR").addEventListener("change", () => pref.set("hand", "right"));
$("handL").addEventListener("change", () => pref.set("hand", "left"));
$("playerSel").addEventListener("change", () => pref.set("playerUid", $("playerSel").value));
$("modelKind").addEventListener("change", () => pref.set("model", $("modelKind").value));

async function onPickVideo(e, fpsHint) {
  const file = e.target.files[0]; if (!file) return;
  if (S.url) URL.revokeObjectURL(S.url);
  S.file = file; S.url = URL.createObjectURL(file); S.target = null; S.candidates = null; S.A = null; S.events = []; S.KP = []; S.F = [];
  $("results").innerHTML = ""; $("emptyAnalyze").hidden = true;
  $("previewBox").hidden = false; $("runBtn").disabled = true;
  $("videoInfo").textContent = "動画を読み込み中…";
  video.src = S.url; video.load();
  try {
    await waitMeta(video);
    S.W = video.videoWidth; S.H = video.videoHeight; S.duration = video.duration;
    $("stage").style.aspectRatio = `${S.W} / ${S.H}`;
    $("videoInfo").textContent = "fpsを調べています…";
    const fps = (await detectFps(video)) || fpsHint || null;
    S.fileFps = fps || 30;
    $("fpsInput").value = fps || 30;
    $("rangeStart").value = 0; $("rangeEnd").value = S.duration.toFixed(1);
    $("videoInfo").textContent = `${S.W}×${S.H}、${S.duration.toFixed(1)}秒、${fps ? fps + "fps" : "fpsを自動で取れませんでした（30として扱います。違えば直してください）"}`;
    $("stageHint").hidden = false;
    drawOverlay();
    $("runBtn").disabled = false;
  } catch (err) {
    $("videoInfo").textContent = "この動画は読み込めませんでした。別の形式（MP4など）で試してください。";
  }
}
$("fileInput").addEventListener("change", onPickVideo);
$("camInput").addEventListener("change", onPickVideo);


// 選手をタップして選ぶ
overlay.addEventListener("click", (e) => {
  if (S.running || !S.W) return;
  if (S.A) return; // 解析後はタップで選び直さない
  const r = overlay.getBoundingClientRect();
  const cr = containRect(r.width, r.height, S.W, S.H);
  const x = (e.clientX - r.left - cr.x) / cr.s, y = (e.clientY - r.top - cr.y) / cr.s;
  if (x < 0 || y < 0 || x > S.W || y > S.H) return;
  if (S.candidates && S.candidates.length) {
    const b = S.candidates.slice().sort((p, q) => Math.hypot(p[0] - x, p[1] - y) - Math.hypot(q[0] - x, q[1] - y))[0];
    S.target = [b[0], b[1]];
  } else S.target = [x, y];
  $("stageHint").hidden = false;
  $("stageHint").textContent = "この選手を追いかけます（選び直すときはもう一度タップ）";
  drawOverlay();
});

function frameIndexAt(t) {
  if (!S.KP.length) return -1;
  const k = Math.floor(t * S.fileFps);
  const j = Math.round((k - S.k0) / S.stride);
  return j >= 0 && j < S.KP.length ? j : -1;
}
function drawOverlay() {
  const { w, h, dpr } = sizeCanvas(overlay);
  const ctx = overlay.getContext("2d"); ctx.clearRect(0, 0, w, h);
  if (!S.W) return;
  const cr = containRect(w, h, S.W, S.H);
  const map = (p) => [cr.x + p[0] * cr.s, cr.y + p[1] * cr.s];
  if (S.candidates && !S.A) {
    ctx.lineWidth = 2 * dpr;
    for (const b of S.candidates) {
      const p = map([b[0] - b[2] / 2, b[1] - b[3] / 2]);
      const chosen = S.target && Math.abs(S.target[0] - b[0]) < 1 && Math.abs(S.target[1] - b[1]) < 1;
      ctx.strokeStyle = chosen ? css("--accent") : "rgba(255,255,255,0.85)"; ctx.setLineDash(chosen ? [] : [6 * dpr, 4 * dpr]);
      ctx.strokeRect(p[0], p[1], b[2] * cr.s, b[3] * cr.s);
    }
    ctx.setLineDash([]);
  }
  if (S.target && !S.A) {
    const p = map(S.target); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3 * dpr;
    ctx.beginPath(); ctx.arc(p[0], p[1], 18 * dpr, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = css("--accent"); ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(p[0], p[1], 18 * dpr, 0, Math.PI * 2); ctx.stroke();
  }
  const j = frameIndexAt(video.currentTime);
  if (j >= 0 && S.KP[j]) {
    drawSkeleton(ctx, S.KP[j].xy, S.KP[j].cf, map, "#ffd23f", Math.max(2, 3 * dpr * Math.min(1, cr.s * 2)));
    if (S.A) {
      const ev = S.events.find((e) => Math.abs(e.main - j) <= 1 || (isNum(e.foot_plant) && Math.abs(e.foot_plant - j) <= 1));
      if (ev) {
        const tag = Math.abs(ev.main - j) <= 1 ? (S.A.mode === "batting" ? "インパクト" : "リリース") : "前足の着地";
        ctx.font = `700 ${16 * dpr}px ${css("--font-body")}`; ctx.fillStyle = "rgba(0,0,0,0.6)";
        const tw = ctx.measureText(tag).width; ctx.fillRect(8 * dpr, 8 * dpr, tw + 16 * dpr, 28 * dpr);
        ctx.fillStyle = "#ffffff"; ctx.fillText(tag, 16 * dpr, 28 * dpr);
      }
    }
  }
}
// 再生中も骨格を重ねる
function overlayLoop() {
  drawOverlay();
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) video.requestVideoFrameCallback(overlayLoop);
  else requestAnimationFrame(overlayLoop);
}
if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) video.requestVideoFrameCallback(overlayLoop); else requestAnimationFrame(overlayLoop);
video.addEventListener("seeked", drawOverlay);
window.addEventListener("resize", () => { drawOverlay(); if (S.A) drawResultCharts(); });

// ===================== 解析を実行 =====================
$("cancelBtn").addEventListener("click", () => { S.cancel = true; });
$("runBtn").addEventListener("click", runAnalysis);

async function runAnalysis() {
  if (S.running || !S.file) return;
  const mode = $("modeBat").checked ? "batting" : "pitching";
  const hand = $("handR").checked ? "right" : "left";
  const fileFps = parseFloat($("fpsInput").value) || S.fileFps || 30;
  S.fileFps = fileFps;
  const realFps = parseFloat($("realFpsInput").value) || fileFps; // スロー動画の撮影fps
  S.realFps = realFps;
  const t0 = Math.max(0, parseFloat($("rangeStart").value) || 0);
  const t1 = Math.min(S.duration, parseFloat($("rangeEnd").value) || S.duration);
  if (t1 - t0 < 0.5) { toast("解析する範囲が短すぎます"); return; }
  S.running = true; S.cancel = false; S.A = null; S.events = []; S.KP = []; S.F = [];
  $("runBtn").disabled = true; $("runBox").hidden = false; $("cancelBtn").hidden = false; $("results").innerHTML = ""; $("stageHint").hidden = true;
  let wake = null; try { wake = await navigator.wakeLock?.request("screen"); } catch (e) { /* なくてもよい */ }
  const prog = (p, msg) => { $("progBar").style.width = `${Math.round(p * 100)}%`; $("progText").textContent = msg; };
  try {
    prog(0, "AIを読み込み中…");
    const kind = $("modelKind").value;
    let model = await loadModel(kind, (p) => prog(p * 0.1, `AIを読み込み中… ${Math.round(p * 100)}%`));
    S.stride = Math.max(1, Math.round(realFps / 60));
    S.k0 = Math.floor(t0 * fileFps);
    const k1 = Math.floor(t1 * fileFps);
    const ks = []; for (let k = S.k0; k < k1; k += S.stride) ks.push(k);
    video.pause();
    // 複数の人が映っていて、選手を選んでいないときは、先に選んでもらう
    await seek(video, (ks[0] + 0.5) / fileFps);
    const first = (await inferFrame(model, video, S.W, S.H));
    const hmax0 = Math.max(0, ...first.map((p) => p.box[3]));
    const people = first.filter((p) => p.box[3] > 0.35 * hmax0);
    if (!S.target && people.length > 1) {
      S.candidates = people.map((p) => p.box); drawOverlay();
      $("stageHint").hidden = false;
      $("stageHint").textContent = `${people.length}人映っています。追いかける選手をタップしてから、もう一度「解析する」を押してください`;
      $("stage").scrollIntoView({ behavior: "smooth", block: "center" });
      prog(0, "追いかける選手を選んでください");
      return;
    }
    S.candidates = null;
    const track = { prev: null, h: null, lost: 0 };
    if (S.target) {
      // タップした位置に一番近い人から始める
      const near = first.slice().sort((p, q) => Math.hypot(p.box[0] - S.target[0], p.box[1] - S.target[1]) - Math.hypot(q.box[0] - S.target[0], q.box[1] - S.target[1]))[0];
      track.prev = near ? [near.box[0], near.box[1]] : S.target.slice(); track.h = near ? near.box[3] : null; track.w = near ? near.box[2] : null;
    }
    const maxLost = Math.round(0.5 * fileFps / S.stride);
    const track0 = { ...track };
    let started = performance.now(), fails = 0;
    const st = { infer: 0, frames: 0, method: "" };
    const pause = async (n) => {
      prog(0.1 + 0.85 * n / ks.length, "一時停止中：このアプリに戻ると続きから解析します");
      started += await waitVisible();
      try { wake = await navigator.wakeLock?.request("screen"); } catch (e) { /* なくてもよい */ }
    };
    // 1コマ分の骨格推定。src はそのコマの画像（null なら取り出せなかったコマ）。
    // afterDraw はAI用の画像を描き終えた直後に呼ぶ（次のコマの読み込みを先に始めるため）。
    // GPUを取り上げられたときは AIを作り直して、redo() でもう一度同じコマを用意してからやり直す
    const step = async (n, src, rot, afterDraw, redo) => {
      if (S.cancel) throw new Error("cancel");
      if (!src) { S.KP.push(null); S.F.push({}); return; }
      let p = null;
      for (;;) {
        let next = null;
        try {
          if (gpuLost()) throw new Error("GPUを取り上げられました");
          const roi = roiFor(track, S.W, S.H);
          const gCrop = roi ? drawNet(lbCrop, src, S.W, S.H, roi, rot) : null;
          const gFull = drawNet(lbFull, src, S.W, S.H, null, rot);
          next = afterDraw ? afterDraw() : null; afterDraw = null;
          const t = performance.now();
          let persons = gCrop ? await runNet(model, gCrop) : [];
          // 切り取った中に選手が見つからないときは、全体から探し直す
          if (!gCrop || !persons.length || persons[0].conf < 0.4) persons = await runNet(model, gFull);
          st.infer += performance.now() - t; st.frames++;
          if (gpuLost()) throw new Error("GPUを取り上げられました");
          p = trackPick(persons, track, maxLost);
          if (next) await next;
          break;
        } catch (err) {
          if (S.cancel) throw new Error("cancel");
          if (++fails > 5) throw err;
          console.warn("AIを作り直します", err);
          prog(0.1 + 0.85 * n / ks.length, "AIを準備し直しています…");
          if (next) await next;
          await waitVisible();
          model = await recoverModel(kind);
          if (redo) src = (await redo()) || src;
        }
      }
      if (p) { S.KP.push({ xy: p.xy, cf: p.cf, box: p.box }); S.F.push(AN.frameFeatures(p.xy, p.cf, 0.5)); }
      else { S.KP.push(null); S.F.push({}); }
      if (n % 3 === 0 || n === ks.length - 1) {
        drawOverlay();
        const el = (performance.now() - started) / 1000, per = el / (n + 1), rest = per * (ks.length - n - 1);
        prog(0.1 + 0.85 * (n + 1) / ks.length, `骨格を推定中 ${n + 1} / ${ks.length} コマ（残り約${fmtRest(rest)}）`);
      }
    };
    // 速い方法：動画を頭から順番にデコードしてコマを取り出す（スマホで撮ったmp4/mov）
    let usedFast = null, missing = 0;
    if (window.Frames && !S.forceSeek) {
      const k1x = ks[ks.length - 1] + 1;
      usedFast = await Frames.run(S.file, {
        fps: fileFps, k0: S.k0, k1: k1x, stride: S.stride,
        isCancelled: () => S.cancel,
        onFrame: async (k, frame, rot) => {
          const n = (k - S.k0) / S.stride;
          if (!frame) missing++;
          if (document.hidden) await pause(n);
          await step(n, frame, rot, null, null);
        },
      }).catch((e) => {
        if (e.message === "cancel") throw e;
        // 途中で失敗したら、最初から今まで通りの方法でやり直す
        console.warn("WebCodecsで失敗したので今まで通りの方法にします", e);
        S.KP = []; S.F = []; Object.assign(track, track0);
        return null;
      });
      if (usedFast && missing > 0.3 * ks.length) { console.warn("取り出せないコマが多いのでやり直します", missing); S.KP = []; S.F = []; usedFast = null; Object.assign(track, track0); }
      if (usedFast && S.KP.length !== ks.length) { console.warn("コマ数が合わないのでやり直します", S.KP.length, ks.length); S.KP = []; S.F = []; usedFast = null; Object.assign(track, track0); }
    }
    if (usedFast) st.method = "高速";
    else {
      // 今まで通りの方法：1コマずつ再生位置を移して取り出す
      st.method = "互換"; started = performance.now();
      await seek(video, (ks[0] + 0.5) / fileFps);
      for (let n = 0; n < ks.length; n++) {
        if (document.hidden) { await pause(n); await seek(video, (ks[n] + 0.5) / fileFps); }
        await step(n, video, 0,
          () => (n + 1 < ks.length ? seek(video, (ks[n + 1] + 0.5) / fileFps) : null),
          async () => { await seek(video, (ks[n] + 0.5) / fileFps); return video; });
      }
    }
    S.stats = { method: st.method, perFrame: (performance.now() - started) / ks.length, infer: st.frames ? st.infer / st.frames : 0, frames: ks.length };
    prog(0.96, "スイング・投球を探しています…");
    const A = AN.analyze(S.F, realFps / S.stride, mode, hand);
    S.A = A; S.dir = AN.targetDirection(S.F, A);
    S.events = A.events.map((e) => ({ ...e, summary: AN.summarizeEvent(S.F, A, e, S.dir), thumb: null, playerUid: $("playerSel").value, player: Store.nameOf($("playerSel").value) }));
    for (const ev of S.events) ev.thumb = await makeThumb(ev.main);
    S.selected = 0;
    prog(1, `完了：${S.events.length}回見つかりました（1コマあたり${(S.stats.perFrame / 1000).toFixed(2)}秒、うちAI ${(S.stats.infer / 1000).toFixed(2)}秒・${S.stats.method}）`);
    renderResults();
    if (S.events.length) await seek(video, Math.max(0, fileTimeOf(S.events[0].main) - 1.0 * secScale()));
  } catch (err) {
    if (err.message === "cancel") prog(0, "中止しました");
    else { console.error(err); prog(0, "解析できませんでした：" + (err.message || err)); }
  } finally {
    S.running = false; $("runBtn").disabled = false; $("cancelBtn").hidden = true;
    try { await wake?.release(); } catch (e) { /* なし */ }
  }
}
// 同じ選手を追い続ける。急に遠くの人へ飛んだら、そのコマは「見失った」扱いにする
function trackPick(persons, st, maxLost) {
  if (!persons.length) { st.lost++; return null; }
  if (!st.prev) {
    const i = AN.pickPerson(persons.map((p) => p.box), null);
    const p = persons[i]; st.prev = [p.box[0], p.box[1]]; st.h = p.box[3]; st.w = p.box[2]; st.lost = 0; return p;
  }
  const scale = st.h || Math.max(...persons.map((p) => p.box[3]));
  let best = null, bd = Infinity;
  for (const p of persons) { const d = Math.hypot(p.box[0] - st.prev[0], p.box[1] - st.prev[1]) / scale; if (d < bd) { bd = d; best = p; } }
  if (bd < 0.6 || st.lost > maxLost) {
    st.prev = [best.box[0], best.box[1]]; st.h = 0.7 * st.h + 0.3 * best.box[3] || best.box[3]; st.w = best.box[2]; st.lost = 0; return best;
  }
  st.lost++; return null;
}
const fmtRest = (sec) => (sec >= 90 ? `${Math.round(sec / 60)}分` : `${Math.ceil(sec)}秒`);
// 解析コマ番号 → 動画の時刻
const fileTimeOf = (j) => (S.k0 + j * S.stride + 0.5) / S.fileFps;
// 実時間1秒が動画上で何秒か（スロー動画の補正。通常は1）
const secScale = () => (S.realFps || S.fileFps) / S.fileFps;

async function makeThumb(j) {
  await seek(video, fileTimeOf(j));
  const kp = S.KP[j];
  const cw = 240, ch = 320, c = document.createElement("canvas"); c.width = cw; c.height = ch;
  const ctx = c.getContext("2d");
  let cx = S.W / 2, cy = S.H / 2, hh = S.H;
  if (kp) {
    const pts = kp.xy.filter((_, i) => kp.cf[i] > 0.3);
    if (pts.length) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      hh = Math.max(80, (Math.max(...ys) - Math.min(...ys)) * 1.35);
    }
  }
  const sc = ch / hh, sx = cx - cw / 2 / sc, sy = cy - ch / 2 / sc;
  ctx.fillStyle = "#0e1418"; ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(video, -sx * sc, -sy * sc, S.W * sc, S.H * sc);
  if (kp) drawSkeleton(ctx, kp.xy, kp.cf, (p) => [(p[0] - sx) * sc, (p[1] - sy) * sc], "#ffd23f", 3);
  return c.toDataURL("image/jpeg", 0.72);
}

// ===================== 結果の表示 =====================
const LABELS = {
  batting: { main: "インパクト", lead_elbow: "前腕の肘", back_elbow: "後ろ腕の肘", lead_knee: "前足の膝" },
  pitching: { main: "リリース", throw_elbow: "投げ腕の肘", glove_elbow: "グラブ腕の肘", lead_knee: "前足の膝" },
};
function metricsTable(sum, mode) {
  const L = LABELS[mode];
  const rows = Object.keys(sum.values).map((k) => `<tr><td>${L[k]}</td><td>${fmt(sum.values[k].atPlant)}°</td><td>${fmt(sum.values[k].atMain)}°</td></tr>`).join("");
  return `<div class="tablewrap"><table class="metrics"><thead><tr><th>角度</th><th>着地</th><th>${L.main}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function summaryChips(sum, mode) {
  const L = LABELS[mode], out = [];
  if (isNum(sum.kneeExtension)) out.push(`<span class="chip ${sum.kneeExtension > 0 ? "turf" : ""}">膝の伸び ${sum.kneeExtension > 0 ? "+" : ""}${fmt(sum.kneeExtension)}°</span>`);
  if (isNum(sum.plantToMain)) out.push(`<span class="chip">着地→${L.main} ${fmt(sum.plantToMain, 2)}秒</span>`);
  if (isNum(sum.stride)) out.push(`<span class="chip">踏み出し ${fmt(sum.stride, 2)}</span>`);
  if (isNum(sum.headForward)) out.push(`<span class="chip">頭の前進 ${fmt(sum.headForward, 2)}</span>`);
  if (!isNum(sum.footPlantTime)) out.push(`<span class="chip flag">着地を検出できず（素振り・構え直しの可能性）</span>`);
  if (sum.flags.length) out.push(`<span class="chip flag">要確認：${esc(sum.flags.join("・"))}</span>`);
  return `<div class="chips">${out.join("")}</div>`;
}

function renderResults() {
  const box = $("results"); const mode = S.A.mode, L = LABELS[mode];
  if (!S.events.length) {
    box.innerHTML = `<div class="card"><h2>スイング・投球が見つかりませんでした</h2><p class="small muted">選手が小さすぎる、体が隠れている、または動きが映っていない可能性があります。選手をタップして選ぶ、解析する範囲を絞る、などを試してください。</p></div>`;
    return;
  }
  const evHtml = S.events.map((ev, i) => `
    <div class="card" id="ev-${i}">
      <div class="ev">
        <img src="${ev.thumb}" alt="${i + 1}回目の${L.main}の瞬間">
        <div class="stack" style="gap:8px;min-width:0">
          <div class="ev-head"><h3>${i + 1}回目</h3><span class="ev-time">${L.main} ${fmt(fileTimeOf(ev.main), 2)}秒</span></div>
          ${summaryChips(ev.summary, mode)}
          ${metricsTable(ev.summary, mode)}
        </div>
      </div>
      <div class="controls">
        <button class="btn small" data-act="select" data-i="${i}">グラフ・再生</button>
        <button class="btn small" data-act="clip" data-i="${i}">動画で保存</button>
        <button class="btn small" data-act="save" data-i="${i}">記録に保存</button>
        <button class="btn small ghost" data-act="drop" data-i="${i}">スイングではない</button>
      </div>
      <div class="sheet" id="sheet-${i}" hidden></div>
    </div>`).join("");
  const sel = S.events[S.selected];
  box.innerHTML = `
    <div class="card">
      <div class="row"><h2 class="grow">${S.events.length}回 見つかりました</h2><span class="small muted">${mode === "batting" ? "打撃" : "投球"}・${S.A.hand === "right" ? "右" : "左"}</span></div>
      <p class="small muted">素振りや構え直しが混ざることがあります。違うものは「スイングではない」で外してください。</p>
    </div>
    <div class="card" id="playerCard">
      <div class="row"><h2 class="grow" id="selTitle"></h2></div>
      <div class="controls">
        <button class="btn small" id="pbJump">この回の頭へ</button>
        <button class="btn small" data-step="-1">◀ 1コマ</button>
        <button class="btn small" data-step="1">1コマ ▶</button>
        <button class="btn small" data-rate="0.25">0.25倍</button>
        <button class="btn small" data-rate="0.5">0.5倍</button>
        <button class="btn small" data-rate="1">等倍</button>
      </div>
      <p class="small muted">上の動画に骨格が重なって再生されます。</p>
      <div><div class="chart-title">前足の膝（°）</div><canvas class="chart" id="chKnee"></canvas></div>
      <div><div class="chart-title" id="chElbowTitle">肘（°）</div><div class="legend" id="lgElbow"></div><canvas class="chart" id="chElbow"></canvas></div>
      <div><div class="chart-title">${mode === "batting" ? "投手" : "捕手"}方向への移動（胴の長さ＝1）</div><div class="legend" id="lgMove"></div><canvas class="chart" id="chMove"></canvas></div>
      ${S.events.length > 1 ? `<div><div class="chart-title">全部の回を重ねる：前足の膝（°）</div><div class="legend" id="lgAll"></div><canvas class="chart" id="chAll"></canvas></div>` : ""}
    </div>
    ${evHtml}`;
  box.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => onEventAction(b.dataset.act, +b.dataset.i)));
  box.querySelectorAll("#playerCard [data-step]").forEach((b) => b.addEventListener("click", async () => { video.pause(); await seek(video, video.currentTime + (+b.dataset.step) / S.fileFps); }));
  box.querySelectorAll("#playerCard [data-rate]").forEach((b) => b.addEventListener("click", () => { video.playbackRate = +b.dataset.rate; video.play().catch(() => {}); }));
  $("pbJump").addEventListener("click", async () => { video.pause(); await seek(video, Math.max(0, fileTimeOf(S.events[S.selected].main) - 1.0 * secScale())); });
  drawResultCharts();
  fillCompareOptions();
}

function windowSeries(ev, pre = 1.0, post = 0.6) {
  const A = S.A, fps = A.fps, m = ev.main;
  const lo = Math.max(0, m - Math.round(pre * fps)), hi = Math.min(S.F.length - 1, m + Math.round(post * fps));
  const idx = []; for (let i = lo; i <= hi; i++) idx.push(i);
  const t = idx.map((i) => (i - m) / fps);
  const base = (key) => AN.nanMedian(S.F.slice(lo, Math.min(hi, lo + Math.round(0.3 * fps)) + 1).map((f) => f[key]));
  const nx = AN.rollMedian(AN.interpolate(S.F.map((f) => f.nose_x), 3), 3), hx = AN.rollMedian(AN.interpolate(S.F.map((f) => f.hip_x), 3), 3);
  const bn = base("nose_x"), bh = base("hip_x");
  const out = { t, idx };
  for (const k of Object.keys(A.cols)) out[k] = idx.map((i) => A.clean[k][i]);
  out.head = idx.map((i) => S.dir * (nx[i] - bn) / A.torso);
  out.hip = idx.map((i) => S.dir * (hx[i] - bh) / A.torso);
  out.tilt = idx.map((i) => S.dir * A.tilt[i]);
  return out;
}
function drawResultCharts() {
  if (!S.A || !S.events.length) return;
  const ev = S.events[S.selected], mode = S.A.mode, L = LABELS[mode];
  $("selTitle").textContent = `${S.selected + 1}回目のグラフ（${L.main}＝0秒）`;
  const w = windowSeries(ev);
  const fp = isNum(ev.foot_plant) ? (ev.foot_plant - ev.main) / S.A.fps : null;
  const markers = [{ x: 0, label: L.main, dash: [5, 4], side: "right" }]; if (fp !== null) markers.push({ x: fp, label: "着地", dash: [2, 3], side: "left" });
  const pts = (arr) => w.t.map((t, i) => [t, arr[i]]);
  drawChart($("chKnee"), { series: [{ color: css("--c1"), pts: pts(w.lead_knee), name: "前足の膝" }], ymin: 90, ymax: 185, markers, xlabel: `${L.main}からの時間（秒）` });
  const elbowKeys = Object.keys(S.A.cols).filter((k) => k !== "lead_knee");
  const eSeries = elbowKeys.map((k, i) => ({ color: css(i ? "--c2" : "--c1"), pts: pts(w[k]), name: L[k] }));
  setLegend("lgElbow", eSeries);
  drawChart($("chElbow"), { series: eSeries, ymin: 20, ymax: 185, markers, xlabel: `${L.main}からの時間（秒）` });
  const mSeries = [{ color: css("--c1"), pts: pts(w.head), name: "頭" }, { color: css("--c2"), pts: pts(w.hip), name: "腰" }];
  setLegend("lgMove", mSeries);
  drawChart($("chMove"), { series: mSeries, markers, xlabel: `${L.main}からの時間（秒）`, pad: 0.1 });
  if (S.events.length > 1 && $("chAll")) {
    const cols = ["--c1", "--c2", "--c3"];
    const all = S.events.map((e, i) => { const ww = windowSeries(e); return { color: i < 3 ? css(cols[i]) : css("--muted"), width: i < 3 ? 2 : 1, pts: ww.t.map((t, k) => [t, ww.lead_knee[k]]), name: `${i + 1}回目` }; });
    setLegend("lgAll", all.slice(0, 3).concat(all.length > 3 ? [{ color: css("--muted"), name: "4回目以降" }] : []));
    drawChart($("chAll"), { series: all, ymin: 90, ymax: 185, markers: [{ x: 0, label: L.main, dash: [5, 4] }], xlabel: `${L.main}からの時間（秒）` });
  }
}
function setLegend(id, series) { const el = $(id); if (el) el.innerHTML = series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join(""); }

async function onEventAction(act, i) {
  const ev = S.events[i];
  if (act === "select") {
    S.selected = i; drawResultCharts();
    $("playerCard").scrollIntoView({ behavior: "smooth", block: "start" });
    video.pause(); await seek(video, Math.max(0, fileTimeOf(ev.main) - 1.0 * secScale()));
  } else if (act === "drop") {
    S.events.splice(i, 1); S.selected = 0; renderResults();
    toast("外しました");
  } else if (act === "save") {
    const sh = $("sheet-" + i); sh.hidden = !sh.hidden;
    if (!sh.hidden) {
      sh.innerHTML = `
        <div class="grid2">
          <label class="field">選手<select id="svP-${i}" ${Store.isStaff() ? "" : "disabled"}>${Store.users.map((u) => `<option value="${esc(u.uid)}" ${u.uid === ev.playerUid ? "selected" : ""}>${esc(u.name || "名前なし")}</option>`).join("")}</select></label>
          <label class="field">日付<input type="date" id="svD-${i}" value="${todayStr()}"></label>
        </div>
        <label class="field">メモ<input type="text" id="svM-${i}" placeholder="例：フリー打撃、好調時" autocomplete="off"></label>
        <button class="btn red" id="svB-${i}">保存する</button>`;
      $("svB-" + i).addEventListener("click", async () => {
        const uid = $("svP-" + i).value;
        const doc = buildSwingDoc(ev, uid, Store.nameOf(uid), $("svD-" + i).value || todayStr(), $("svM-" + i).value.trim());
        try { await Store.add("swings", doc); sh.hidden = true; toast("記録に保存しました"); }
        catch (e) { console.error(e); toast(e && e.code === "no-player" ? "先に「記録」画面の名簿に選手を追加して、選んでください" : "保存できませんでした。通信状態を確認してください"); }
      });
    }
  } else if (act === "clip") {
    const sh = $("sheet-" + i); sh.hidden = false;
    sh.innerHTML = `
      <div class="row">
        <div class="seg" role="radiogroup" aria-label="速さ">
          <label><input type="radio" name="clipRate-${i}" value="1" checked><span>等倍</span></label>
          <label><input type="radio" name="clipRate-${i}" value="0.5"><span>0.5倍</span></label>
          <label><input type="radio" name="clipRate-${i}" value="0.25"><span>0.25倍</span></label>
        </div>
        <label class="row small"><input type="checkbox" id="clipSk-${i}" checked> 骨格を重ねる</label>
      </div>
      <p class="small muted">${L_main()}の1.5秒前から1秒後までを動画にします。作っている間は動画が再生されます。</p>
      <button class="btn red" id="clipGo-${i}">動画を作る</button>
      <span class="small muted" id="clipMsg-${i}"></span>`;
    $("clipGo-" + i).addEventListener("click", async () => {
      const rate = +document.querySelector(`input[name="clipRate-${i}"]:checked`).value;
      const msg = $("clipMsg-" + i); $("clipGo-" + i).disabled = true; msg.textContent = "動画を作っています…";
      try {
        const { blob, ext } = await recordClip(ev, rate, $("clipSk-" + i).checked);
        const name = `${(ev.player || "swing").replace(/[\\/:*?"<>|\s]/g, "_")}_${i + 1}.${ext}`;
        msg.textContent = "保存の確認を表示します…";
        await saveFile(name, blob);
        msg.textContent = "保存しました";
      } catch (e) { msg.textContent = e && e.message ? e.message : "動画を作れませんでした"; }
      finally { $("clipGo-" + i).disabled = false; }
    });
  }
}
const L_main = () => (S.A && S.A.mode === "pitching" ? "リリース" : "インパクト");

// ===================== 切り出し動画 =====================
async function recordClip(ev, rate, withSkeleton) {
  if (typeof MediaRecorder === "undefined") throw new Error("このブラウザでは動画を作れません");
  const tMain = fileTimeOf(ev.main), start = Math.max(0, tMain - 1.5 * secScale()), end = Math.min(S.duration, tMain + 1.0 * secScale());
  const maxW = 1280, sc = Math.min(1, maxW / Math.max(S.W, S.H));
  const cv = document.createElement("canvas"); cv.width = Math.round(S.W * sc / 2) * 2; cv.height = Math.round(S.H * sc / 2) * 2;
  const ctx = cv.getContext("2d");
  const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
  const stream = cv.captureStream(30);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6 } : undefined);
  const chunks = []; rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const draw = () => {
    ctx.drawImage(video, 0, 0, cv.width, cv.height);
    const j = frameIndexAt(video.currentTime);
    if (withSkeleton && j >= 0 && S.KP[j]) drawSkeleton(ctx, S.KP[j].xy, S.KP[j].cf, (p) => [p[0] * sc, p[1] * sc], "#ffd23f", Math.max(2, 4 * sc));
  };
  await seek(video, start); draw();
  const stopped = new Promise((res) => { rec.onstop = res; });
  rec.start(250);
  video.playbackRate = rate; video.muted = true;
  await new Promise((res) => {
    let done = false;
    const tick = () => { if (done) return; draw(); if (video.currentTime >= end || video.ended) { done = true; video.pause(); res(); return; } schedule(); };
    const schedule = () => ("requestVideoFrameCallback" in HTMLVideoElement.prototype ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick));
    schedule();
    video.play().catch(() => { done = true; res(); });
    setTimeout(() => { if (!done) { done = true; video.pause(); res(); } }, ((end - start) / rate + 5) * 1000);
  });
  draw(); await sleep(200); rec.stop(); await stopped;
  video.playbackRate = 1;
  const type = rec.mimeType || mime || "video/webm";
  return { blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm" };
}
// 動画の保存：スマホでは共有メニュー（「ビデオを保存」）、パソコンではダウンロード
async function saveFile(filename, blob) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e && e.name === "AbortError") throw new Error("保存をやめました"); }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ===================== 記録用のデータ =====================
function buildSwingDoc(ev, playerUid, player, date, memo) {
  const A = S.A, w = windowSeries(ev);
  const r1 = (v) => (isNum(v) ? Math.round(v * 10) / 10 : null), r3 = (v) => (isNum(v) ? Math.round(v * 1000) / 1000 : null);
  // 骨格：構えのときの腰の位置を原点、胴の長さを1、投げる（投手）方向を右にそろえる
  let anchor = null;
  for (const i of w.idx) { const k = S.KP[i]; if (k && k.cf[11] > 0.5 && k.cf[12] > 0.5) { anchor = [(k.xy[11][0] + k.xy[12][0]) / 2, (k.xy[11][1] + k.xy[12][1]) / 2]; break; } }
  const skel = w.idx.map((i) => {
    const k = S.KP[i]; if (!k || !anchor) return null;
    const a = []; for (let p = 0; p < 17; p++) a.push(r3(S.dir * (k.xy[p][0] - anchor[0]) / A.torso), r3((k.xy[p][1] - anchor[1]) / A.torso), Math.round(k.cf[p] * 100) / 100);
    return a;
  });
  const series = { t: w.t.map(r3), head: w.head.map(r3), hip: w.hip.map(r3) };
  for (const k of Object.keys(A.cols)) series[k] = w[k].map(r1);
  const s = ev.summary, values = {};
  for (const [k, v] of Object.entries(s.values)) values[k] = { atPlant: isNum(v.atPlant) ? v.atPlant : null, atMain: isNum(v.atMain) ? v.atMain : null };
  return {
    playerUid: playerUid || "", player: player || "", date, memo, mode: A.mode, hand: A.hand, fps: Math.round(A.fps * 100) / 100,
    plantToMain: r3(s.plantToMain), kneeExtension: isNum(s.kneeExtension) ? s.kneeExtension : null,
    stride: r3(s.stride), headForward: r3(s.headForward), headDrop: r3(s.headDrop), footPlantT: isNum(ev.foot_plant) ? r3((ev.foot_plant - ev.main) / A.fps) : null,
    values, flags: s.flags, series, skel, thumb: ev.thumb, source: S.file ? S.file.name : "",
  };
}
// 比較用に、今回の解析のものも記録と同じ形にそろえる
function sessionSwings() { return S.A ? S.events.map((ev, i) => ({ key: "s" + i, label: `今回の動画 ${i + 1}回目`, doc: buildSwingDoc(ev, ev.playerUid, ev.player, todayStr(), "") })) : []; }

// ===================== 比較 =====================
function swingLabel(d) { return `${d.date || ""} ${d.player || ""}（${d.mode === "batting" ? "打撃" : "投球"}${d.memo ? "・" + d.memo : ""}）`; }
function fillCompareOptions() {
  const opts = [...sessionSwings().map((s) => ({ key: s.key, label: s.label })), ...Store.data.swings.slice().sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).map((d) => ({ key: "r" + d.id, label: swingLabel(d) }))];
  $("cmpEmpty").hidden = opts.length > 0;
  for (const id of ["cmpA", "cmpB"]) {
    const sel = $(id), cur = sel.value;
    sel.innerHTML = opts.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join("");
    if (opts.some((o) => o.key === cur)) sel.value = cur;
  }
  if (opts.length > 1 && $("cmpA").value === $("cmpB").value) $("cmpB").selectedIndex = 1;
}
function getSwing(key) {
  if (key.startsWith("s")) { const s = sessionSwings().find((x) => x.key === key); return s && s.doc; }
  return Store.data.swings.find((d) => "r" + d.id === key);
}
let cmpAnim = null;
$("cmpBtn").addEventListener("click", () => {
  const a = getSwing($("cmpA").value), b = getSwing($("cmpB").value);
  if (!a || !b) { toast("2つ選んでください"); return; }
  renderCompare(a, b);
});
function renderCompare(a, b) {
  if (cmpAnim) cancelAnimationFrame(cmpAnim);
  const mainA = a.mode === "pitching" ? "リリース" : "インパクト";
  const sameMode = a.mode === b.mode;
  const LA = LABELS[a.mode];
  const keys = Object.keys(a.values || {});
  const row = (name, va, vb, unit, d = 0) => {
    const diff = isNum(va) && isNum(vb) ? vb - va : NaN;
    return `<tr><td>${name}</td><td>${fmt(va, d)}${unit}</td><td>${fmt(vb, d)}${unit}</td><td>${isNum(diff) ? (diff > 0 ? "+" : "") + diff.toFixed(d) : "—"}</td></tr>`;
  };
  let rows = "";
  if (sameMode) {
    for (const k of keys) {
      rows += row(`${LA[k]}（着地）`, a.values[k].atPlant, b.values[k]?.atPlant, "°");
      rows += row(`${LA[k]}（${mainA}）`, a.values[k].atMain, b.values[k]?.atMain, "°");
    }
  }
  rows += row("前足の膝の伸び", a.kneeExtension, b.kneeExtension, "°");
  rows += row(`着地→${mainA}`, a.plantToMain, b.plantToMain, "秒", 2);
  rows += row("踏み出し幅", a.stride, b.stride, "", 2);
  rows += row("頭の前進", a.headForward, b.headForward, "", 2);
  $("cmpOut").innerHTML = `
    <div class="card">
      <div class="grid2">
        <div class="stack" style="gap:6px"><img src="${a.thumb || ""}" alt="Aの${mainA}" style="width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:8px;background:var(--stage)"><span class="small"><b style="color:var(--c1)">A</b> ${esc(swingLabel(a))}</span></div>
        <div class="stack" style="gap:6px"><img src="${b.thumb || ""}" alt="Bの${mainA}" style="width:100%;aspect-ratio:3/4;object-fit:cover;border-radius:8px;background:var(--stage)"><span class="small"><b style="color:var(--c2)">B</b> ${esc(swingLabel(b))}</span></div>
      </div>
    </div>
    <div class="card">
      <h2>骨格を重ねる</h2>
      <p class="small muted">構えたときの腰の位置と体の大きさをそろえ、${a.mode === "batting" ? "投手" : "捕手"}方向を右にそろえています。</p>
      <div class="stage" style="aspect-ratio:4/3"><canvas id="cmpCanvas"></canvas></div>
      <div class="row"><button class="btn small" id="cmpPlay">再生</button><input type="range" id="cmpSeek" min="0" max="1000" value="0" class="grow" aria-label="時間"><span class="mono small" id="cmpT"></span></div>
    </div>
    <div class="card">
      <h2>着地時・${mainA}時の比較</h2>
      <div class="tablewrap"><table class="metrics"><thead><tr><th>項目</th><th>A</th><th>B</th><th>B−A</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div><div class="chart-title">前足の膝（°）</div><div class="legend"><span><i style="background:${css("--c1")}"></i>A</span><span><i style="background:${css("--c2")}"></i>B</span></div><canvas class="chart" id="cmpKnee"></canvas></div>
      ${sameMode ? keys.filter((k) => k !== "lead_knee").map((k) => `<div><div class="chart-title">${LA[k]}（°）</div><canvas class="chart" id="cmpC-${k}"></canvas></div>`).join("") : ""}
      <div><div class="chart-title">頭の前進（胴の長さ＝1）</div><canvas class="chart" id="cmpHead"></canvas></div>
    </div>`;
  const ser = (d, k, color) => ({ color, pts: (d.series?.t || []).map((t, i) => [t, d.series[k] ? d.series[k][i] : null]).filter((p) => p[1] !== null && p[1] !== undefined), name: "" });
  const mk = [{ x: 0, label: mainA, dash: [5, 4] }];
  drawChart($("cmpKnee"), { series: [ser(a, "lead_knee", css("--c1")), ser(b, "lead_knee", css("--c2"))], ymin: 90, ymax: 185, markers: mk, xlabel: `${mainA}からの時間（秒）` });
  if (sameMode) for (const k of keys.filter((k) => k !== "lead_knee")) drawChart($("cmpC-" + k), { series: [ser(a, k, css("--c1")), ser(b, k, css("--c2"))], ymin: 20, ymax: 185, markers: mk, xlabel: `${mainA}からの時間（秒）` });
  drawChart($("cmpHead"), { series: [ser(a, "head", css("--c1")), ser(b, "head", css("--c2"))], markers: mk, xlabel: `${mainA}からの時間（秒）`, pad: 0.1 });
  // 骨格アニメーション
  const tA = a.series?.t || [], tB = b.series?.t || [];
  const tmin = Math.max(Math.min(...tA), Math.min(...tB)), tmax = Math.min(Math.max(...tA), Math.max(...tB));
  let cur = tmin, playing = false, last = 0;
  const near = (ts, t) => { let bi = 0; for (let i = 0; i < ts.length; i++) if (Math.abs(ts[i] - t) < Math.abs(ts[bi] - t)) bi = i; return bi; };
  const drawFrame = () => {
    const cv = $("cmpCanvas"); if (!cv) return;
    const { w, h, dpr } = sizeCanvas(cv); const ctx = cv.getContext("2d");
    ctx.fillStyle = css("--stage"); ctx.fillRect(0, 0, w, h);
    const sc = h / 5, ox = w * 0.4, oy = h * 0.45;
    ctx.strokeStyle = "rgba(255,255,255,0.15)"; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(w, oy); ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.stroke();
    for (const [d, color] of [[a, css("--c1")], [b, css("--c2")]]) {
      const fr = d.skel && d.skel[near(d.series.t, cur)]; if (!fr) continue;
      const xy = [], cf = []; for (let p = 0; p < 17; p++) { xy.push([fr[3 * p], fr[3 * p + 1]]); cf.push(fr[3 * p + 2]); }
      drawSkeleton(ctx, xy, cf, (p) => [ox + p[0] * sc, oy + p[1] * sc], color, 3.5 * dpr);
    }
    ctx.fillStyle = "#ffffff"; ctx.font = `700 ${13 * dpr}px ${css("--font-mono")}`;
    ctx.fillText(`${cur >= 0 ? "+" : ""}${cur.toFixed(2)}s`, 10 * dpr, 20 * dpr);
    $("cmpT").textContent = Math.abs(cur) < 0.02 ? mainA : `${cur >= 0 ? "+" : ""}${cur.toFixed(2)}秒`;
    $("cmpSeek").value = String(Math.round((cur - tmin) / (tmax - tmin || 1) * 1000));
  };
  const loop = (ts) => {
    if (!playing) return;
    const dt = last ? (ts - last) / 1000 : 0; last = ts; cur += dt * 0.25;
    if (cur > tmax) cur = tmin;
    drawFrame(); cmpAnim = requestAnimationFrame(loop);
  };
  $("cmpPlay").addEventListener("click", () => { playing = !playing; $("cmpPlay").textContent = playing ? "止める" : "再生"; last = 0; if (playing) cmpAnim = requestAnimationFrame(loop); });
  $("cmpSeek").addEventListener("input", (e) => { playing = false; $("cmpPlay").textContent = "再生"; cur = tmin + (+e.target.value / 1000) * (tmax - tmin); drawFrame(); });
  cur = 0 >= tmin && 0 <= tmax ? 0 : tmin; drawFrame();
}

// ===================== 記録 =====================
const METRICS = [
  { key: "kneeExtension", name: "前足の膝の伸び（°）", kind: "swings", get: (d) => d.kneeExtension },
  { key: "plantToMain", name: "着地→インパクト／リリース（秒）", kind: "swings", get: (d) => d.plantToMain },
  { key: "stride", name: "踏み出し幅（胴の長さ比）", kind: "swings", get: (d) => d.stride },
  { key: "headForward", name: "頭の前進（胴の長さ比）", kind: "swings", get: (d) => d.headForward },
  { key: "kneeMain", name: "前足の膝・インパクト／リリース時（°）", kind: "swings", get: (d) => d.values?.lead_knee?.atMain },
  { key: "kmh", name: "球速（km/h）", kind: "speeds", get: (d) => d.kmh },
];
$("recMetric").innerHTML = METRICS.map((m) => `<option value="${m.key}">${m.name}</option>`).join("");
$("recMetric").value = pref.get("recMetric", "kneeExtension");
$("recMetric").addEventListener("change", () => { pref.set("recMetric", $("recMetric").value); renderRecords(); });
$("recPlayer").addEventListener("change", renderRecords);
const pendingDelete = new Set();
function renderRecords() {
  const cur = $("recPlayer").value;
  const ids = [...new Set([...Store.data.swings, ...Store.data.speeds].map((d) => d.playerUid).filter(Boolean))];
  const nm = (uid) => Store.nameOf(uid) || ([...Store.data.swings, ...Store.data.speeds].find((d) => d.playerUid === uid) || {}).player || "名前なし";
  $("recPlayer").innerHTML = `<option value="">全員</option>` + ids.sort((x, y) => nm(x).localeCompare(nm(y), "ja")).map((u) => `<option value="${esc(u)}">${esc(nm(u))}</option>`).join("");
  if (ids.includes(cur)) $("recPlayer").value = cur;
  renderRoster();
  if ($("tab-records").hidden) return;
  const pf = $("recPlayer").value;
  const items = [
    ...Store.data.swings.map((d) => ({ ...d, kind: "swings" })),
    ...Store.data.speeds.map((d) => ({ ...d, kind: "speeds" })),
  ].filter((d) => !pf || d.playerUid === pf).sort((a, b) => ((b.date || "") + (b.createdAt || "")).localeCompare((a.date || "") + (a.createdAt || "")));
  $("recCount").textContent = `${items.length}件`;
  $("recList").innerHTML = items.length ? items.map((d) => {
    const head = `<b>${esc(d.player || "名前なし")}</b> <span class="small muted">${esc(d.date || "")}</span>`;
    if (d.kind === "speeds") return `<div class="rec"><div class="speed-thumb">${fmt(d.kmh)}</div><div class="stack" style="gap:2px;min-width:0">${head}<span class="small">球速 ${fmt(d.kmh, 1)} km/h（${fmt(d.frames)}コマ・${fmt(d.fps)}fps）${d.memo ? "・" + esc(d.memo) : ""}</span></div><button class="btn small ghost" data-del="${d.kind}:${esc(d.id)}">${pendingDelete.has(d.id) ? "本当に消す" : "消す"}</button></div>`;
    const m = d.mode === "pitching" ? "リリース" : "インパクト";
    return `<div class="rec">${d.thumb ? `<img src="${d.thumb}" alt="">` : `<div class="speed-thumb">${d.mode === "pitching" ? "投" : "打"}</div>`}<div class="stack" style="gap:2px;min-width:0">${head}<span class="small">${d.mode === "batting" ? "打撃" : "投球"}・${d.hand === "right" ? "右" : "左"}${d.memo ? "・" + esc(d.memo) : ""}</span><span class="small muted mono">膝の伸び ${isNum(d.kneeExtension) ? (d.kneeExtension > 0 ? "+" : "") + d.kneeExtension + "°" : "—"} ／ 着地→${m} ${fmt(d.plantToMain, 2)}秒</span></div><button class="btn small ghost" data-del="${d.kind}:${esc(d.id)}">${pendingDelete.has(d.id) ? "本当に消す" : "消す"}</button></div>`;
  }).join("") : `<div class="empty"><p class="small muted">まだ記録がありません。「解析」の結果で「記録に保存」を押すか、「球速」で測った値を保存すると、ここにたまっていきます。</p></div>`;
  $("recList").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    const [kind, id] = b.dataset.del.split(":");
    if (!pendingDelete.has(id)) { pendingDelete.add(id); renderRecords(); setTimeout(() => { pendingDelete.delete(id); renderRecords(); }, 4000); return; }
    pendingDelete.delete(id);
    try { await Store.remove(kind, id); toast("消しました"); } catch (e) { toast("消せませんでした"); }
  }));
  const met = METRICS.find((m) => m.key === $("recMetric").value) || METRICS[0];
  const pts = (met.kind === "swings" ? Store.data.swings : Store.data.speeds).filter((d) => !pf || d.playerUid === pf)
    .map((d) => ({ d: d.date || (d.createdAt || "").slice(0, 10), c: d.createdAt || "", v: met.get(d), p: d.player }))
    .filter((x) => isNum(x.v)).sort((a, b) => (a.d + a.c).localeCompare(b.d + b.c));
  $("recChartTitle").textContent = `${met.name}の推移${pf ? "（" + nm(pf) + "）" : Store.isStaff() ? "（全員）" : ""}`;
  drawChart($("recChart"), { series: [{ color: css("--c1"), pts: pts.map((x, i) => [i, x.v]), dots: true, name: met.name }], xticks: pts.map((x, i) => [i, x.d.slice(5).replace("-", "/")]), pad: 0.15, empty: "記録が2件以上たまると推移が表示されます", minPoints: 2 });
}
Store.onChange(() => { renderRecords(); fillCompareOptions(); });

// ===================== 球速 =====================
const SP = { fileFps: 30, rel: null, catch: null, url: null };
const spVideo = $("spVideo");
const spFrame = () => Math.round(spVideo.currentTime * SP.fileFps - 0.5);
function spUpdate() {
  $("spPos").textContent = `${spFrame()} コマ目（${spVideo.currentTime.toFixed(3)}秒）`;
  if (spVideo.duration) $("spSeek").value = String(Math.round(spVideo.currentTime / spVideo.duration * 1000));
  $("spRel").textContent = SP.rel === null ? "—" : `${SP.rel} コマ目`;
  $("spCatch").textContent = SP.catch === null ? "—" : `${SP.catch} コマ目`;
  const fps = parseFloat($("spFps").value) || SP.fileFps, dist = parseFloat($("spDist").value) || 17;
  if (SP.rel !== null && SP.catch !== null && SP.catch > SP.rel) {
    const n = SP.catch - SP.rel, kmh = dist / (n / fps) * 3.6;
    const hi = dist / ((n - 1) / fps) * 3.6, lo = dist / ((n + 1) / fps) * 3.6;
    $("spKmh").innerHTML = `${kmh.toFixed(1)}<small>km/h</small>`;
    $("spDetail").textContent = `${n}コマ（${(n / fps).toFixed(3)}秒）で${dist}m。印が1コマずれると ${lo.toFixed(0)}〜${n > 1 ? hi.toFixed(0) : "—"} km/h の幅があります。fpsが高いほど正確になります。`;
    $("spSave").hidden = false; SP.result = { kmh: Math.round(kmh * 10) / 10, frames: n, fps, distance: dist };
  } else {
    $("spKmh").innerHTML = `—<small>km/h</small>`;
    $("spDetail").textContent = SP.rel !== null && SP.catch !== null ? "捕球はリリースより後のコマにしてください。" : "動画を選んで、リリースと捕球の瞬間に印を付けると計算されます。";
    $("spSave").hidden = true; SP.result = null;
  }
}
async function onPickSpeed(e, fpsHint) {
  const f = e.target.files[0]; if (!f) return;
  if (SP.url) URL.revokeObjectURL(SP.url);
  SP.url = URL.createObjectURL(f); SP.rel = null; SP.catch = null;
  spVideo.src = SP.url; spVideo.load(); $("spBox").hidden = false;
  try {
    await waitMeta(spVideo);
    spVideo.parentElement.style.aspectRatio = `${spVideo.videoWidth} / ${spVideo.videoHeight}`;
    const fps = (await detectFps(spVideo)) || fpsHint || null; SP.fileFps = fps || 30; $("spFps").value = fps || 30;
    spUpdate();
  } catch (err) { toast("この動画は読み込めませんでした"); }
}
$("spFile").addEventListener("change", onPickSpeed);
$("spCam").addEventListener("change", onPickSpeed);

document.querySelectorAll("#spBox [data-step]").forEach((b) => b.addEventListener("click", async () => {
  spVideo.pause(); await seek(spVideo, (spFrame() + (+b.dataset.step) + 0.5) / SP.fileFps); spUpdate();
}));
$("spSeek").addEventListener("input", async (e) => { if (!spVideo.duration) return; await seek(spVideo, (+e.target.value / 1000) * spVideo.duration); spUpdate(); });
$("spMarkRel").addEventListener("click", () => { SP.rel = spFrame(); spUpdate(); });
$("spMarkCatch").addEventListener("click", () => { SP.catch = spFrame(); spUpdate(); });
$("spFps").addEventListener("input", spUpdate);
$("spDist").addEventListener("input", spUpdate);
$("spDate").value = todayStr();
$("spSaveBtn").addEventListener("click", async () => {
  if (!SP.result) return;
  try {
    const uid = $("spPlayerSel").value;
    await Store.add("speeds", { ...SP.result, playerUid: uid, player: Store.nameOf(uid) || "名前なし", date: $("spDate").value || todayStr(), memo: $("spMemo").value.trim() });
    toast("記録に保存しました");
  } catch (e) { toast(e && e.code === "no-player" ? "先に「記録」画面の名簿に選手を追加して、選んでください" : "保存できませんでした"); }
});

// ===================== グラフ（キャンバスに手描き） =====================
function drawChart(cv, o) {
  if (!cv) return;
  const { w, h, dpr } = sizeCanvas(cv); const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const ink = css("--ink"), muted = css("--muted"), line = css("--line");
  const font = (px, wgt = 500) => `${wgt} ${px * dpr}px ${css("--font-body")}`;
  const all = o.series.flatMap((s) => s.pts.filter((p) => isNum(p[0]) && isNum(p[1])));
  if (all.length < (o.minPoints || 1)) {
    ctx.fillStyle = muted; ctx.font = font(13); ctx.textAlign = "center"; ctx.fillText(o.empty || "データがありません", w / 2, h / 2); ctx.textAlign = "left"; return;
  }
  let xmin = Math.min(...all.map((p) => p[0])), xmax = Math.max(...all.map((p) => p[0]));
  let ymin = o.ymin ?? Math.min(...all.map((p) => p[1])), ymax = o.ymax ?? Math.max(...all.map((p) => p[1]));
  if (o.ymin === undefined || o.ymax === undefined) { const r = (ymax - ymin) || 1; ymin -= r * (o.pad || 0.1); ymax += r * (o.pad || 0.1); }
  if (xmax === xmin) { xmin -= 1; xmax += 1; }
  const L = 38 * dpr, R = 10 * dpr, T = 14 * dpr, B = (o.xlabel ? 34 : 24) * dpr;
  const X = (x) => L + (x - xmin) / (xmax - xmin) * (w - L - R), Y = (y) => T + (1 - (y - ymin) / (ymax - ymin)) * (h - T - B);
  // 目盛り
  const step = niceStep((ymax - ymin) / 4);
  ctx.font = font(11); ctx.fillStyle = muted; ctx.strokeStyle = line; ctx.lineWidth = 1 * dpr; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = Math.ceil(ymin / step) * step; v <= ymax + 1e-9; v += step) {
    ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - R, Y(v)); ctx.stroke();
    ctx.fillText(Math.abs(step) < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v)), L - 6 * dpr, Y(v));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  if (o.xticks) {
    const every = Math.max(1, Math.ceil(o.xticks.length / 6));
    o.xticks.forEach(([x, lab], i) => {
      if (!(i % every === 0 || i === o.xticks.length - 1)) return;
      const tw = ctx.measureText(lab).width;
      ctx.textAlign = X(x) + tw / 2 > w ? "right" : X(x) - tw / 2 < 0 ? "left" : "center";
      ctx.fillText(lab, X(x), h - B + 6 * dpr);
    });
    ctx.textAlign = "center";
  } else {
    const xs = niceStep((xmax - xmin) / 5);
    for (let v = Math.ceil(xmin / xs) * xs; v <= xmax + 1e-9; v += xs) ctx.fillText((Math.abs(v) < 1e-9 ? 0 : v).toFixed(xs < 1 ? 1 : 0), X(v), h - B + 6 * dpr);
  }
  if (o.xlabel) { ctx.fillText(o.xlabel, (L + w - R) / 2, h - 15 * dpr); }
  // 縦の印（着地・インパクト）
  for (const m of o.markers || []) {
    if (m.x < xmin || m.x > xmax) continue;
    ctx.save(); ctx.strokeStyle = muted; ctx.setLineDash(m.dash.map((d) => d * dpr)); ctx.beginPath(); ctx.moveTo(X(m.x), T); ctx.lineTo(X(m.x), h - B); ctx.stroke(); ctx.restore();
    ctx.fillStyle = muted; ctx.font = font(10, 700); ctx.textBaseline = "top";
    const tw = ctx.measureText(m.label).width;
    let side = m.side || (m.x > (xmin + xmax) / 2 ? "left" : "right");
    if (side === "left" && X(m.x) - tw - 4 * dpr < L) side = "right";
    if (side === "right" && X(m.x) + tw + 4 * dpr > w - R) side = "left";
    ctx.textAlign = side === "right" ? "left" : "right";
    ctx.fillText(m.label, X(m.x) + (side === "right" ? 3 : -3) * dpr, T);
  }
  // 線
  for (const s of o.series.slice().reverse()) {
    ctx.strokeStyle = s.color; ctx.lineWidth = (s.width || 2) * dpr; ctx.lineJoin = "round"; ctx.beginPath(); let pen = false;
    for (const p of s.pts) { if (!isNum(p[1])) { pen = false; continue; } const x = X(p[0]), y = Y(Math.max(ymin, Math.min(ymax, p[1]))); if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; } }
    ctx.stroke();
    if (s.dots) { ctx.fillStyle = s.color; for (const p of s.pts) if (isNum(p[1])) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 4 * dpr, 0, Math.PI * 2); ctx.fill(); } }
  }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; void ink;
}
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

// ===================== 選手の名簿 =====================
const pendingRoster = new Set();
function renderRoster() {
  const el = $("rosterList"); if (!el) return;
  const count = (uid) => [...Store.data.swings, ...Store.data.speeds].filter((d) => d.playerUid === uid).length;
  el.innerHTML = Store.users.length ? Store.users.map((u) => `
    <div class="member"><div style="min-width:0"><b>${esc(u.name)}</b><br><span class="small muted">記録 ${count(u.uid)}件</span></div>
    <button class="btn small ghost" data-delp="${esc(u.uid)}">${pendingRoster.has(u.uid) ? "本当に消す" : "名簿から消す"}</button></div>`).join("")
    : `<p class="small muted">まだ選手がいません。上の欄に名前を入れて「追加」を押してください。</p>`;
  el.querySelectorAll("[data-delp]").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.delp;
    if (!pendingRoster.has(id)) { pendingRoster.add(id); renderRoster(); setTimeout(() => { pendingRoster.delete(id); renderRoster(); }, 4000); return; }
    pendingRoster.delete(id);
    try { await FB.deletePlayer(id); toast("名簿から消しました（記録は残ります）"); } catch (e) { toast("消せませんでした"); }
  }));
}
$("addPlayerBtn").addEventListener("click", async () => {
  const name = $("newPlayer").value.trim(); if (!name) return;
  if (Store.users.some((u) => u.name === name)) { toast("同じ名前の選手がもういます"); return; }
  try { const id = await FB.addPlayer(name); $("newPlayer").value = ""; pref.set("playerUid", id); toast(`${name}さんを追加しました`); }
  catch (e) { toast("追加できませんでした"); }
});
$("newPlayer").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("addPlayerBtn").click(); } });
document.querySelectorAll("[data-goto-roster]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); showTab("records"); setTimeout(() => { $("rosterCard").scrollIntoView({ behavior: "smooth" }); $("newPlayer").focus(); }, 50); }));

function showApp(on) { $("appMain").hidden = !on; $("appNav").hidden = !on; $("meBox").hidden = !on; $("connectView").hidden = on; }

// ===================== アプリ内カメラ =====================
const CAM = { stream: null, rec: null, chunks: [], facing: "environment", target: null, t0: 0, timer: null };
async function camOpen(target) {
  CAM.target = target; $("camModal").hidden = false; $("camInfo").textContent = "カメラを準備しています…";
  await camStart();
}
async function camStart() {
  camStopStream();
  try {
    CAM.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: CAM.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } } });
    const v = $("camVideo"); v.srcObject = CAM.stream; await v.play().catch(() => {});
    const st = CAM.stream.getVideoTracks()[0].getSettings();
    CAM.fps = st.frameRate ? Math.round(st.frameRate) : null;
    $("camInfo").textContent = `${st.width || ""}×${st.height || ""}${CAM.fps ? "・" + CAM.fps + "fps" : ""}　選手の全身が入るように横から撮ってください`;
  } catch (e) {
    $("camInfo").textContent = "カメラを使えませんでした。ブラウザの設定でカメラを許可するか、「撮影する」ボタンを使ってください。";
  }
}
function camStopStream() { if (CAM.stream) CAM.stream.getTracks().forEach((t) => t.stop()); CAM.stream = null; }
function camClose() { if (CAM.rec && CAM.rec.state === "recording") CAM.rec.stop(); camStopStream(); clearInterval(CAM.timer); $("camModal").hidden = true; $("camRec").classList.remove("on"); }
$("camOpenA").addEventListener("click", () => camOpen("analyze"));
$("camOpenS").addEventListener("click", () => camOpen("speed"));
$("camClose").addEventListener("click", camClose);
$("camFlip").addEventListener("click", () => { if (CAM.rec && CAM.rec.state === "recording") return; CAM.facing = CAM.facing === "environment" ? "user" : "environment"; camStart(); });
$("camRec").addEventListener("click", () => {
  if (!CAM.stream) return;
  if (CAM.rec && CAM.rec.state === "recording") { CAM.rec.stop(); return; }
  const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mime = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
  CAM.chunks = [];
  CAM.rec = new MediaRecorder(CAM.stream, mime ? { mimeType: mime, videoBitsPerSecond: 12e6 } : undefined);
  CAM.rec.ondataavailable = (e) => { if (e.data && e.data.size) CAM.chunks.push(e.data); };
  CAM.rec.onstop = () => {
    clearInterval(CAM.timer); $("camRec").classList.remove("on");
    const type = CAM.rec.mimeType || mime || "video/webm";
    const file = new File(CAM.chunks, `camera.${type.includes("mp4") ? "mp4" : "webm"}`, { type });
    const fps = CAM.fps; camClose();
    if (CAM.target === "speed") onPickSpeed({ target: { files: [file] } }, fps);
    else onPickVideo({ target: { files: [file] } }, fps);
  };
  CAM.rec.start(500); CAM.t0 = Date.now(); $("camRec").classList.add("on");
  CAM.timer = setInterval(() => { $("camInfo").textContent = `録画中 ${((Date.now() - CAM.t0) / 1000).toFixed(1)}秒（もう一度押すと止まります）`; }, 200);
});

// ===================== 起動 =====================
(function boot() {
  const mode = pref.get("mode", "batting"); $(mode === "pitching" ? "modePitch" : "modeBat").checked = true;
  $(pref.get("hand", "right") === "left" ? "handL" : "handR").checked = true;
  $("modelKind").value = pref.get("model", "s");
  updateHandLabels();
  const tab = pref.get("tab", "analyze"); showTab(TABS.includes(tab) ? tab : "analyze");
  const go = () => {
    if (!window.FB) { $("connectView").hidden = true; $("setupView").hidden = false; return; }
    FB.start((uid) => { Store.start(uid); showApp(true); renderRecords(); fillCompareOptions(); },
      (e) => { console.error(e); $("connectMsg").textContent = "チームの記録につなげませんでした。Firebaseで「匿名」ログインを有効にしたか確認してください（手順書の2）。"; });
  };
  if (window.FB !== undefined) go();
  else { window.addEventListener("fb-ready", go, { once: true }); window.addEventListener("fb-missing", go, { once: true }); }
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (S.A) drawResultCharts(); renderRecords(); });
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
