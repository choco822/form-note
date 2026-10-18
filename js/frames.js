// 動画のコマを「頭から順番に」取り出す（WebCodecs）。
// 1コマずつ動画の再生位置を飛ばす方法より、スマホでもずっと速い。
// MP4/MOV（スマホのカメラで撮った動画）だけに使い、使えないときは null を返す（今まで通りの方法に戻す）。
"use strict";
(function () {
  const supported = () => typeof VideoDecoder === "function" && typeof EncodedVideoChunk === "function" && typeof MP4Box === "object";

  // mp4ファイルを読み込んで、映像トラックの情報とすべてのサンプル（圧縮されたコマ）を取り出す
  async function demux(file) {
    const mp4 = MP4Box.createFile();
    let info = null, err = null;
    mp4.onReady = (i) => { info = i; };
    mp4.onError = (e) => { err = e; };
    const CH = 4 * 1024 * 1024;
    for (let off = 0; off < file.size; off += CH) {
      const buf = await file.slice(off, Math.min(file.size, off + CH)).arrayBuffer();
      buf.fileStart = off;
      mp4.appendBuffer(buf);
      if (err) throw new Error(String(err));
    }
    mp4.flush();
    if (!info) throw new Error("mp4として読めませんでした");
    const track = info.videoTracks && info.videoTracks[0];
    if (!track) throw new Error("映像トラックがありません");
    const samples = [];
    mp4.onSamples = (id, user, ss) => { for (const s of ss) samples.push(s); };
    mp4.setExtractionOptions(track.id, null, { nbSamples: 1e9 });
    mp4.start();
    mp4.flush();
    if (!samples.length) throw new Error("コマを取り出せませんでした");
    // デコーダーに渡す設定（H.264/H.265/AV1 は追加の情報が必要）
    let description;
    const trak = mp4.getTrackById(track.id);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.av1C;
      if (box) {
        const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(ds);
        description = new Uint8Array(ds.buffer, 8);
        break;
      }
    }
    // 縦向きで撮った動画は、回転の情報だけが付いている（中身は横向き）
    const m = track.matrix || [65536, 0, 0, 0, 65536, 0, 0, 0, 1 << 30];
    let rot = Math.round(Math.atan2(m[1], m[0]) * 180 / Math.PI);
    rot = ((rot % 360) + 360) % 360;
    rot = [0, 90, 180, 270].reduce((a, b) => (Math.abs(b - rot) < Math.abs(a - rot) ? b : a), 0);
    const config = { codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description, optimizeForLatency: false };
    return { config, samples, rot, timescale: track.timescale };
  }

  // 解析するコマ（k0 から stride ごと、k1 の手前まで）を順番に onFrame(位置, コマ, 回転) へ渡す。
  // 取り出せなかったコマは onFrame(位置, null)。onFrame が終わったら、コマは自動で閉じる。
  async function run(file, { fps, k0, k1, stride, onFrame, isCancelled, onStats }) {
    if (!supported()) return null;
    const lower = (file.name || "").toLowerCase(), type = (file.type || "").toLowerCase();
    if (!(/\.(mp4|mov|m4v|3gp)$/.test(lower) || /mp4|quicktime|3gpp/.test(type))) return null;
    let dm;
    try { dm = await demux(file); } catch (e) { console.warn("WebCodecs: 読み込めないので今まで通りの方法にします", e); return null; }
    let sup;
    try { sup = await VideoDecoder.isConfigSupported(dm.config); } catch (e) { sup = null; }
    if (!sup || !sup.supported) { console.warn("WebCodecs: この形式はデコードできません", dm.config.codec); return null; }

    const ss = dm.samples, ts = (s) => (1e6 * s.cts) / s.timescale;
    const t0us = Math.min(...ss.map(ts));
    const kOf = (us) => Math.round(((us - t0us) / 1e6) * fps);
    // 解析を始めるコマより前の、いちばん近いキーフレームからデコードする
    let start = 0;
    for (let i = 0; i < ss.length; i++) { if (ss[i].is_sync && kOf(ts(ss[i])) <= k0) start = i; }
    // 取り出したコマを順番に並べて待たせる（多すぎるとメモリを使うので、デコードを待たせる）
    const queue = [];
    let waiter = null, decErr = null;
    const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
    const dec = new VideoDecoder({
      output: (frame) => { queue.push(frame); wake(); },
      error: (e) => { decErr = e; wake(); },
    });
    try { dec.addEventListener("dequeue", () => wake()); } catch (e) { /* 古いブラウザ */ }
    dec.configure(dm.config);
    let fed = start, flushed = false;
    const feedMore = () => {
      while (fed < ss.length && dec.decodeQueueSize < 6 && queue.length < 6) {
        const s = ss[fed++];
        dec.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: ts(s), duration: (1e6 * s.duration) / s.timescale, data: s.data }));
        // 解析範囲を十分過ぎたら、それ以上は読まない
        if (kOf(ts(s)) > k1 + 30) { fed = ss.length; }
      }
      if (fed >= ss.length && !flushed) { flushed = true; dec.flush().then(wake, (e) => { decErr = decErr || e; wake(); }); }
    };
    const stats = { wait: 0, frames: 0 };
    let want = k0, done = false, lastOut = -1;
    try {
      while (!done) {
        if (isCancelled && isCancelled()) throw new Error("cancel");
        if (decErr) throw decErr;
        feedMore();
        if (!queue.length) {
          if (flushed && dec.decodeQueueSize === 0) {
            // flush の完了を少し待ってから、もう出てこなければ終わり
            const t = performance.now();
            await new Promise((r) => { waiter = r; setTimeout(r, 300); });
            stats.wait += performance.now() - t;
            if (!queue.length) break;
          } else {
            const t = performance.now();
            await new Promise((r) => { waiter = r; setTimeout(r, 30); });
            stats.wait += performance.now() - t;
          }
          continue;
        }
        // 表示順に並んでいないことがあるので、時刻の早い順に取り出す
        queue.sort((a, b) => a.timestamp - b.timestamp);
        const frame = queue.shift();
        const k = kOf(frame.timestamp);
        if (k <= lastOut) { frame.close(); continue; }
        lastOut = k;
        while (want < k1 && want + stride <= k) { await onFrame(want, null, dm.rot); want += stride; }
        if (want >= k1) { frame.close(); done = true; break; }
        if (k >= want) {
          try { await onFrame(want, frame, dm.rot); } finally { frame.close(); }
          stats.frames++;
          want += stride;
          if (want >= k1) done = true;
        } else frame.close();
      }
      while (want < k1) { await onFrame(want, null, dm.rot); want += stride; }
    } finally {
      for (const f of queue) f.close();
      try { if (dec.state !== "closed") dec.close(); } catch (e) { /* なし */ }
      if (onStats) onStats(stats);
    }
    return true;
  }

  // コマ（VideoFrame）を、回転を直してから描く。W×H は回転後（画面に出る向き）の大きさ
  function drawRotated(ctx, src, W, H, rot) {
    if (!rot) { ctx.drawImage(src, 0, 0, W, H); return; }
    const sw = rot % 180 ? H : W, sh = rot % 180 ? W : H;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
    ctx.restore();
  }

  window.Frames = { supported, run, drawRotated };
})();
