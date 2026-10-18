// 投球・打撃フォーム解析のロジック（Colabノートブックと同じ考え方をJavaScriptに移したもの）
(function (root) {
  "use strict";
  const KP = { nose: 0, l_shoulder: 5, r_shoulder: 6, l_elbow: 7, r_elbow: 8, l_wrist: 9, r_wrist: 10,
    l_hip: 11, r_hip: 12, l_knee: 13, r_knee: 14, l_ankle: 15, r_ankle: 16 };
  const L_ARM = [5, 7, 9], R_ARM = [6, 8, 10], L_LEG = [11, 13, 15], R_LEG = [12, 14, 16];
  const SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16]];
  const isNum = (v) => typeof v === "number" && !Number.isNaN(v);

  // ---- 時系列の道具（pandasの rolling / interpolate と同じ振る舞い） ----
  function win(fps, sec, minimum = 3) {
    let n = Math.max(minimum, Math.round(fps * sec));
    return n % 2 ? n : n + 1;
  }
  function rolling(arr, w, minPeriods, fn) {
    const h = Math.floor(w / 2), out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const vals = [];
      for (let j = Math.max(0, i - h); j <= Math.min(arr.length - 1, i + h); j++) if (isNum(arr[j])) vals.push(arr[j]);
      out[i] = vals.length >= minPeriods ? fn(vals) : NaN;
    }
    return out;
  }
  const median = (v) => { const s = v.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const rollMedian = (a, w, mp = 1) => rolling(a, w, mp, median);
  const rollMean = (a, w, mp = 1) => rolling(a, w, mp, mean);
  function interpolate(arr, limit, insideOnly = false) {
    const out = arr.slice(); const n = arr.length;
    let i = 0;
    while (i < n) {
      if (isNum(out[i])) { i++; continue; }
      const start = i; while (i < n && !isNum(arr[i])) i++;
      const end = i; // [start, end) は欠け
      const prev = start - 1, next = end < n ? end : -1;
      if (prev < 0) continue;                       // 先頭の欠けは埋めない
      for (let k = start; k < Math.min(end, start + limit); k++) {
        if (next >= 0) out[k] = arr[prev] + (arr[next] - arr[prev]) * (k - prev) / (next - prev);
        else if (!insideOnly) out[k] = arr[prev];   // 末尾は最後の値で埋める
      }
    }
    return out;
  }
  const nanMedian = (a) => { const v = a.filter(isNum); return v.length ? median(v) : NaN; };

  // ---- 1コマの処理 ----
  function angle(a, b, c) {
    const bax = a[0] - b[0], bay = a[1] - b[1], bcx = c[0] - b[0], bcy = c[1] - b[1];
    const cos = (bax * bcx + bay * bcy) / (Math.hypot(bax, bay) * Math.hypot(bcx, bcy) + 1e-9);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }
  // 最初は一番大きい人（または指定した位置に近い人）、以降は前のコマの人に一番近い人
  function pickPerson(boxes, prevCenter) {
    const areas = boxes.map((b) => b[2] * b[3]); const amax = Math.max(...areas);
    if (!prevCenter) return areas.indexOf(amax);
    let best = 0, bestScore = Infinity;
    boxes.forEach((b, i) => {
      const d = Math.hypot(b[0] - prevCenter[0], b[1] - prevCenter[1]) / Math.sqrt(amax);
      const s = d - 0.3 * areas[i] / amax;
      if (s < bestScore) { bestScore = s; best = i; }
    });
    return best;
  }
  function frameFeatures(xy, cf, minConf) {
    const ok = (idx) => idx.every((i) => cf[i] >= minConf);
    const ang = (idx) => ok(idx) ? angle(xy[idx[0]], xy[idx[1]], xy[idx[2]]) : NaN;
    const pt = (i) => cf[i] >= minConf ? xy[i] : [NaN, NaN];
    const sh = [(xy[5][0] + xy[6][0]) / 2, (xy[5][1] + xy[6][1]) / 2];
    const hp = [(xy[11][0] + xy[12][0]) / 2, (xy[11][1] + xy[12][1]) / 2];
    const trunkOk = ok([5, 6, 11, 12]);
    const f = { l_elbow: ang(L_ARM), r_elbow: ang(R_ARM), l_knee: ang(L_LEG), r_knee: ang(R_LEG),
      torso_px: trunkOk ? Math.hypot(sh[0] - hp[0], sh[1] - hp[1]) : NaN,
      hip_x: trunkOk ? hp[0] : NaN, hip_y: trunkOk ? hp[1] : NaN, sh_x: trunkOk ? sh[0] : NaN, sh_y: trunkOk ? sh[1] : NaN };
    for (const name of ["nose", "l_wrist", "r_wrist", "l_ankle", "r_ankle"]) {
      const p = pt(KP[name]); f[name + "_x"] = p[0]; f[name + "_y"] = p[1];
    }
    return f;
  }

  // ---- 掃除・速さ・瞬間検出 ----
  function cleanAngle(s, fps, fast = false) {
    let a = s.map((v) => (isNum(v) && v >= 30 ? v : NaN));
    const w = fast ? win(fps, 0.1, 3) : win(fps, 0.23, 5);
    const med = rollMedian(a, w, 2);
    a = a.map((v, i) => (isNum(v) && isNum(med[i]) && Math.abs(v - med[i]) > 35 ? NaN : v));
    a = interpolate(a, win(fps, 0.13), true);
    return fast ? a : rollMean(a, win(fps, 0.1), 1);
  }
  function speed(F, prefix, fps, torso, smoothSec) {
    const lim = win(fps, 0.1), w = win(fps, smoothSec);
    const x = rollMedian(interpolate(F.map((f) => f[prefix + "_x"]), lim), w, 1);
    const y = rollMedian(interpolate(F.map((f) => f[prefix + "_y"]), lim), w, 1);
    const v = x.map((_, i) => (i === 0 ? NaN : Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) * fps / torso));
    return rollMean(v, win(fps, 0.1), 1);
  }
  // scipy.signal.find_peaks（height / distance / prominence）と同じ考え方
  function findPeaks(x, height, distance, prominence) {
    let peaks = [];
    for (let i = 1; i < x.length - 1; i++) {
      if (x[i] > x[i - 1]) {
        let j = i; while (j + 1 < x.length && x[j + 1] === x[i]) j++;
        if (j + 1 < x.length && x[j + 1] < x[i]) peaks.push((i + j) >> 1);
        i = j;
      }
    }
    peaks = peaks.filter((p) => x[p] >= height);
    // 間隔：高い山から順に残し、近すぎる山を消す
    const order = peaks.slice().sort((a, b) => x[b] - x[a]); const keep = new Set();
    const removed = new Set();
    for (const p of order) {
      if (removed.has(p)) continue; keep.add(p);
      for (const q of peaks) if (q !== p && Math.abs(q - p) < distance) removed.add(q);
    }
    peaks = peaks.filter((p) => keep.has(p));
    return peaks.filter((p) => {
      let lmin = x[p], rmin = x[p];
      for (let i = p - 1; i >= 0 && x[i] <= x[p]; i--) lmin = Math.min(lmin, x[i]);
      for (let i = p + 1; i < x.length && x[i] <= x[p]; i++) rmin = Math.min(rmin, x[i]);
      return x[p] - Math.max(lmin, rmin) >= prominence;
    });
  }
  function findEvents(F, mode, hand, fps) {
    const torso = nanMedian(F.map((f) => f.torso_px));
    const side = hand === "right" ? "r" : "l", lead = side === "r" ? "l" : "r";
    let hs;
    if (mode === "batting") {
      const a = speed(F, "l_wrist", fps, torso, 0.1), b = speed(F, "r_wrist", fps, torso, 0.1);
      hs = a.map((v, i) => (v + b[i]) / 2);
    } else hs = speed(F, side + "_wrist", fps, torso, 0.1);
    const ank = speed(F, lead + "_ankle", fps, torso, 0.17);
    const h0 = hs.map((v) => (isNum(v) ? v : 0)); const hmax = Math.max(...h0);
    const peaks = findPeaks(h0, Math.max(0.5 * hmax, 3), Math.trunc(1.5 * fps), 0.4 * hmax);
    const events = peaks.map((p) => {
      const lo = Math.max(0, p - Math.trunc(1.0 * fps));
      const a = ank.slice(lo, p + 1).map((v) => (isNum(v) ? v : 0));
      let fp = NaN;
      const amax = Math.max(...a);
      if (a.length > 3 && amax > 1.0) {
        const top = a.indexOf(amax);
        for (let k = top; k < a.length; k++) if (a[k] < 0.35 * amax) { fp = lo + k; break; }
      }
      return { main: p, foot_plant: fp };
    });
    return { events, handSpeed: hs, ankleSpeed: ank, torso };
  }

  function namesFor(mode, hand) {
    const side = hand === "right" ? "r" : "l", other = side === "r" ? "l" : "r";
    if (mode === "batting") return { lead_elbow: other + "_elbow", back_elbow: side + "_elbow", lead_knee: other + "_knee" };
    return { throw_elbow: side + "_elbow", glove_elbow: other + "_elbow", lead_knee: other + "_knee" };
  }
  const JP = { lead_elbow: "前腕の肘", back_elbow: "後ろ腕の肘", throw_elbow: "投げ腕の肘", glove_elbow: "グラブ腕の肘", lead_knee: "前足の膝" };

  // 動画1本分の解析：F は1コマごとの frameFeatures（人がいないコマは {}）
  function analyze(F, fps, mode, hand) {
    const cols = namesFor(mode, hand);
    const clean = {}, raw = {};
    for (const [label, col] of Object.entries(cols)) {
      raw[label] = F.map((f) => (f[col] === undefined ? NaN : f[col]));
      clean[label] = cleanAngle(raw[label], fps, mode === "pitching");
    }
    const ev = findEvents(F, mode, hand, fps);
    const tilt = F.map((f) => (isNum(f.sh_x) ? Math.atan2(-(f.sh_x - f.hip_x), -(f.sh_y - f.hip_y)) * 180 / Math.PI : NaN));
    return { cols, clean, raw, tilt, ...ev, fps, mode, hand };
  }

  function valueAt(A, label, i) {
    if (!isNum(i)) return { v: NaN, flag: false };
    const v = A.clean[label][i], r = A.raw[label][i];
    return { v: isNum(v) ? Math.round(v) : NaN, flag: !(isNum(r) && r >= 30) };
  }
  // 1回分のまとめ（ノートブックの表と同じ項目）
  function summarizeEvent(F, A, e, dir) {
    const fps = A.fps, side = A.hand === "right" ? "r" : "l", lead = side === "r" ? "l" : "r";
    const m = e.main, fp = e.foot_plant, torso = A.torso;
    const out = { mainTime: m / fps, footPlantTime: isNum(fp) ? fp / fps : NaN, plantToMain: isNum(fp) ? (m - fp) / fps : NaN, values: {}, flags: [] };
    for (const label of Object.keys(A.cols)) {
      const a = valueAt(A, label, fp), b = valueAt(A, label, m);
      out.values[label] = { atPlant: a.v, atMain: b.v };
      if (a.flag || b.flag) out.flags.push(JP[label]);
    }
    const k = out.values.lead_knee;
    out.kneeExtension = isNum(k.atPlant) && isNum(k.atMain) ? k.atMain - k.atPlant : NaN;
    if (isNum(fp)) {
      out.stride = Math.abs(F[fp][lead + "_ankle_x"] - F[fp][side + "_ankle_x"]) / torso;
      const lo = Math.max(0, fp - Math.trunc(1.5 * fps));
      const a = A.ankleSpeed.slice(lo, fp + 1).map((v) => (isNum(v) ? v : 0)); const amax = Math.max(...a);
      let start = fp - (a.length - 1) + a.indexOf(amax);
      while (start > 0 && A.ankleSpeed[start] > 0.35 * amax) start--;
      const nx = interpolate(F.map((f) => f.nose_x), 3), ny = interpolate(F.map((f) => f.nose_y), 3);
      // dir: 投手（投げる）方向が画面の右なら +1、左なら -1
      out.headForward = dir * (nx[m] - nx[start]) / torso;
      out.headDrop = (ny[m] - ny[start]) / torso;
    } else { out.stride = NaN; out.headForward = NaN; out.headDrop = NaN; }
    return out;
  }
  // 投手（投げる）方向：前足が着地したとき、前足が後ろ足より画面の右にあれば右向き
  function targetDirection(F, A) {
    const side = A.hand === "right" ? "r" : "l", lead = side === "r" ? "l" : "r";
    const d = [];
    for (const e of A.events) { const i = isNum(e.foot_plant) ? e.foot_plant : e.main; const f = F[i] || {}; if (isNum(f[lead + "_ankle_x"]) && isNum(f[side + "_ankle_x"])) d.push(f[lead + "_ankle_x"] - f[side + "_ankle_x"]); }
    const md = nanMedian(d);
    return isNum(md) && md < 0 ? -1 : 1;
  }

  const api = { KP, SKELETON, win, rollMedian, rollMean, interpolate, nanMedian, angle, pickPerson, frameFeatures,
    cleanAngle, speed, findPeaks, findEvents, namesFor, analyze, summarizeEvent, targetDirection, JP, isNum };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Analysis = api;
})(typeof window !== "undefined" ? window : globalThis);
