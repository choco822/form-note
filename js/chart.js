// 一球チャート：試合の登録、1球ずつの入力（試合中／試合後に動画を見ながら）、集計、CSV書き出し
// app.js の $, esc, toast, css, pref, Store, sizeCanvas, isNum, fmt, todayStr を使う
"use strict";
(function () {
  // ---------- 球種（設定で追加・名前変更・並べ替え・非表示ができる。記録には id を残すので、名前を変えても崩れない） ----------
  const DEFAULT_TYPES = [
    ["fa", "ストレート"], ["ft", "ツーシーム"], ["sl", "スライダー"], ["sw", "スイーパー"], ["ct", "カットボール"], ["kc", "パワーカーブ"], ["cu", "スローカーブ"],
    ["ch", "チェンジアップ"], ["fs", "スプリット"], ["fo", "フォークボール"], ["si", "シンカー"], ["sh", "シュート"], ["ot", "その他"],
  ].map(([id, name]) => ({ id, name, hidden: false }));
  const PALETTE = ["#e5484d", "#f5a524", "#3e63dd", "#12a594", "#8e4ec6", "#46a758", "#00a2c7", "#d6409f", "#bd4b00", "#6e56cf", "#a18072", "#5b8a3a", "#8d8d8d",
    "#e54666", "#0090ff", "#ffc53d", "#29a383", "#7c66dc", "#ff8b3e", "#978365"];

  const RESULTS = [
    { id: "B", label: "ボール", cls: "" },
    { id: "CS", label: "見逃し", cls: "" },
    { id: "SS", label: "空振り", cls: "red" },
    { id: "F", label: "ファウル", cls: "" },
    { id: "X", label: "打球", cls: "turf" },
    { id: "HBP", label: "死球", cls: "" },
  ];
  const RES_LABEL = { B: "ボール", CS: "見逃し", SS: "空振り", F: "ファウル", X: "打球", HBP: "死球" };
  const BB_TYPES = [["G", "ゴロ"], ["L", "ライナー"], ["F", "フライ"], ["P", "内野フライ"], ["BU", "バント"]];
  const BB_RES = [
    ["OUT", "アウト", 1], ["1B", "単打", 0], ["2B", "二塁打", 0], ["3B", "三塁打", 0], ["HR", "本塁打", 0],
    ["E", "エラー", 0], ["FC", "野選", 1], ["SAC", "犠打", 1], ["SF", "犠飛", 1], ["DP", "併殺", 2],
  ];
  // 打球方向（スコアブックの守備位置）。座標は本塁＝原点、外野フェンスまで＝1
  const POS = [["1", "投", 0, 0.2], ["2", "捕", 0, 0.04], ["3", "一", 0.25, 0.3], ["4", "二", 0.13, 0.43], ["6", "遊", -0.13, 0.43], ["5", "三", -0.25, 0.3],
    ["7", "左", -0.45, 0.62], ["78", "左中", -0.27, 0.76], ["8", "中", 0, 0.8], ["89", "右中", 0.27, 0.76], ["9", "右", 0.45, 0.62]];
  const posLabel = (id) => (POS.find((x) => x[0] === id) || [0, ""])[1];
  const nearestPos = (x, y) => POS.reduce((a, b) => (Math.hypot(b[2] - x, b[3] - y) < Math.hypot(a[2] - x, a[3] - y) ? b : a))[0];
  const PA_LABEL = { K: "三振", BB: "四球", HBP: "死球", OUT: "アウト", "1B": "単打", "2B": "二塁打", "3B": "三塁打", HR: "本塁打", E: "エラー", FC: "野選", SAC: "犠打", SF: "犠飛", DP: "併殺" };
  const HITS = ["1B", "2B", "3B", "HR"];
  const HAND = { R: "右", L: "左", S: "両" };

  const C = {
    games: [], types: DEFAULT_TYPES, view: "home", gameId: null, pitches: [], pending: 0, unsub: null,
    sel: { typeId: null, zone: null, speed: "", editId: null }, mode: "live",
    video: { url: null, t0: null, name: "" },
    stats: { game: "all", side: "opp", team: "", tab: "p", who: null },
    confirmDel: null,
  };
  const root = () => $("chartRoot");
  const game = () => C.games.find((g) => g.id === C.gameId) || null;
  const visibleTypes = () => C.types.filter((t) => !t.hidden);
  const typeById = (id) => C.types.find((t) => t.id === id);
  const typeColor = (id) => { const i = C.types.findIndex((t) => t.id === id); return i < 0 ? "#8d8d8d" : PALETTE[i % PALETTE.length]; };
  const typeName = (p) => (typeById(p.typeId) || {}).name || p.typeName || "";
  const zxP = (p) => (isNum(p.zx) ? (p.zview === "P" ? p.zx : -p.zx) : null); // 投手から見た横の位置（右が＋）
  const zoneView = () => pref.get("chartZoneView", "P"); // 入力の向き：P＝投手から見た図、C＝捕手から見た図
  const pname = (p) => (p ? `${p.number ? "#" + p.number + " " : ""}${p.name || "名前なし"}` : "");
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---------- 選手 ----------
  const allPlayers = () => Store.allPlayers || Store.users || [];
  const ourPlayers = () => allPlayers().filter((p) => !p.team);
  const oppPlayers = (team) => allPlayers().filter((p) => p.team && p.team === team);
  const teams = () => [...new Set([...C.games.map((g) => g.opponent), ...allPlayers().map((p) => p.team)].filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
  const ref = (p, hand) => (p ? { pid: p.uid, name: p.name, number: p.number || "", hand: hand || "" } : null);

  // ---------- 試合の状態（カウント・アウト・イニング・打順） ----------
  const initLive = (usP, oppP) => ({ inning: 1, half: "T", outs: 0, balls: 0, strikes: 0, slot: { us: 0, opp: 0 }, pitcher: { us: usP || null, opp: oppP || null }, seq: 1, runs: { us: [], opp: [] } });
  const batTeam = (g, s) => ((s.half === "T") === !!g.usTop ? "us" : "opp");
  const fieldTeam = (g, s) => (batTeam(g, s) === "us" ? "opp" : "us");
  const curBatter = (g, s) => { const t = batTeam(g, s); return (g.lineup && g.lineup[t] && g.lineup[t][s.slot[t]]) || null; };
  const curPitcher = (g, s) => (s.pitcher && s.pitcher[fieldTeam(g, s)]) || null;
  const halfLabel = (s) => `${s.inning}回${s.half === "T" ? "表" : "裏"}`;
  const teamName = (g, t) => (t === "us" ? "自チーム" : g.opponent || "相手");
  // 1球の結果から、次の状態を作る
  function advance(g, st, r, bbRes) {
    const s = clone(st), bat = batTeam(g, s);
    let paEnd = false, pa = null, outs = 0;
    if (r === "B") { s.balls++; if (s.balls >= 4) { paEnd = true; pa = "BB"; } }
    else if (r === "CS" || r === "SS") { s.strikes++; if (s.strikes >= 3) { paEnd = true; pa = "K"; outs = 1; } }
    else if (r === "F") { if (s.strikes < 2) s.strikes++; }
    else if (r === "HBP") { paEnd = true; pa = "HBP"; }
    else if (r === "X") { paEnd = true; pa = bbRes || "OUT"; outs = (BB_RES.find((b) => b[0] === pa) || [0, 0, 0])[2]; }
    if (paEnd) { s.balls = 0; s.strikes = 0; s.slot[bat] = (s.slot[bat] + 1) % 9; }
    s.outs += outs;
    if (s.outs >= 3) nextHalf(s);
    s.seq++;
    return { s, paEnd, pa, outs };
  }
  function nextHalf(s) { s.outs = 0; s.balls = 0; s.strikes = 0; if (s.half === "T") s.half = "B"; else { s.half = "T"; s.inning++; } }
  function prevHalf(s) { s.outs = 0; s.balls = 0; s.strikes = 0; if (s.half === "B") s.half = "T"; else if (s.inning > 1) { s.half = "B"; s.inning--; } }
  // 保存が途中で切れたときのために、最後の1球から状態を作り直す
  function liveOf(g) {
    let s = g.live ? clone(g.live) : initLive();
    const last = C.pitches.length && C.gameId === g.id ? C.pitches.reduce((a, b) => (b.seq > a.seq ? b : a)) : null;
    if (last && last.seq >= s.seq && last.pre) { try { s = advance(g, JSON.parse(last.pre), last.result, last.bbRes).s; } catch (e) { /* そのまま */ } }
    s.runs = s.runs || { us: [], opp: [] };
    return s;
  }
  const effBats = (b, p) => { const h = b && b.hand; if (h === "S") return p && p.hand === "L" ? "R" : "L"; return h || ""; };

  // ---------- データの読み込み ----------
  function start() {
    if (!window.FB || !FB.watchGames) return;
    FB.watchGames((gs) => {
      C.games = gs.sort((a, b) => ((b.date || "") + (b.createdAt || "")).localeCompare((a.date || "") + (a.createdAt || "")));
      if (!$("tab-chart").hidden && (C.view === "home" || C.view === "live")) render(C.view === "live");
    }, () => toast("試合の一覧を読み込めませんでした"));
    FB.watchSetting("pitchTypes", (d) => {
      if (d && Array.isArray(d.types) && d.types.length) C.types = d.types;
      if (!$("tab-chart").hidden && C.view !== "setup" && C.view !== "types" && C.view !== "stats") render(C.view === "live");
    }, () => {});
  }
  function openGame(id) {
    if (C.unsub) { C.unsub(); C.unsub = null; }
    C.gameId = id; C.pitches = []; C.pending = 0;
    if (!id) return;
    C.unsub = FB.watchPitches(id, (ps, pending) => {
      C.pitches = ps.sort((a, b) => a.seq - b.seq); C.pending = pending || 0;
      if (!$("tab-chart").hidden && (C.view === "live" || C.view === "stats")) render(true);
    }, () => toast("この試合の記録を読み込めませんでした"));
  }

  // ---------- 画面の切り替え ----------
  function go(view, opt = {}) {
    C.view = view;
    if (opt.gameId !== undefined && opt.gameId !== C.gameId) openGame(opt.gameId);
    if (opt.mode) C.mode = opt.mode;
    C.sel = { typeId: null, zone: null, speed: "", editId: null };
    document.body.classList.toggle("chart-live", view === "live");
    render(); window.scrollTo({ top: 0 });
  }
  function render(soft) {
    const r = root(); if (!r) return;
    document.body.classList.toggle("chart-live", C.view === "live" && !$("tab-chart").hidden);
    if (C.view === "home") return renderHome(r);
    if (C.view === "setup") return soft ? null : renderSetup(r);
    if (C.view === "live") return renderLive(r, soft);
    if (C.view === "stats") return renderStats(r, soft);
    if (C.view === "types") return soft ? null : renderTypes(r);
  }

  // ===================== 試合の一覧 =====================
  function renderHome(r) {
    const rows = C.games.map((g) => {
      const s = g.live || initLive();
      return `<div class="ch-game">
        <div style="min-width:0"><b>${esc(g.date || "")}　vs ${esc(g.opponent || "")}</b><br>
        <span class="small muted">${g.usTop ? "先攻" : "後攻"}・${halfLabel(s)}まで入力${g.memo ? "・" + esc(g.memo) : ""}</span></div>
        <div class="controls">
          <button class="btn small primary" data-g-live="${esc(g.id)}">入力</button>
          <button class="btn small" data-g-video="${esc(g.id)}">動画で入力</button>
          <button class="btn small" data-g-stats="${esc(g.id)}">集計</button>
          <button class="btn small ghost" data-g-edit="${esc(g.id)}">編集</button>
          <button class="btn small ghost" data-g-del="${esc(g.id)}">${C.confirmDel === g.id ? "本当に消す" : "消す"}</button>
        </div></div>`;
    }).join("");
    r.innerHTML = `
      <div class="card">
        <div class="row"><h2 class="grow">一球チャート</h2></div>
        <div class="controls">
          <button class="btn red" id="chNew" type="button">＋ 新しい試合</button>
          <button class="btn" id="chStatsAll" type="button">集計（全試合）</button>
          <button class="btn ghost" id="chTypes" type="button">球種の設定</button>
        </div>
      </div>
      <details class="card ch-help">
        <summary><b>使い方（試合中に入力する人へ）</b></summary>
        <ol class="steps small">
          <li><span>試合の前に「＋ 新しい試合」で、相手チーム・先攻後攻・両チームの打順と先発投手を入れる（相手の打順は分からなければ空でOK）</span></li>
          <li><span>試合中は、1球ごとに結果のボタンを1回押すだけ：<b>ボール／見逃し／空振り／ファウル／打球／死球</b>。カウント・アウト・イニング・次の打者は自動で進みます</span></li>
          <li><span>「打球」のときは、ゴロ・フライなどの種類 → 打球方向（守備位置を押すか、グラウンドの図をタップ）→ 結果（アウト・単打など）</span></li>
          <li><span>押し間違えたら「1球取り消し」（2回押すと取り消し）</span></li>
          <li><span>投手交代・代打は、上の「投」「打」の欄を押して選びます。名簿にいない選手は、その場で背番号と名前を入れて追加できます</span></li>
          <li><span>盗塁死・けん制死などでアウトが増えたとき、得点が入ったときは「手で直す・交代」で直します</span></li>
          <li><span>電波が悪くても入力は止まりません。「未送信」と出ていても、電波が戻ると自動で送られます</span></li>
          <li><span>球種やコースが分かる人は「球種・コースも入れる」をオンにすると入力できます。分からなければ、試合後に動画を見ながら「動画で入力」で足せます</span></li>
        </ol>
        <b class="small">試合の撮影のコツ</b>
        <ul class="ch-tips">
          <li>バックネット裏の高い位置から、投手・打者・捕手が入るように三脚で固定する</li>
          <li>画質は720p・30fpsで十分（2時間で5GBほど）。スマホの空き容量を確認しておく</li>
          <li>モバイルバッテリーをつないでおく。機内モードにすると電池が長持ちします</li>
          <li>途中で止めずに撮りっぱなしにすると、あとで入力と合わせやすくなります</li>
        </ul>
      </details>
      <div class="card">
        <h2>試合</h2>
        ${rows || `<p class="small muted">まだ試合がありません</p>`}
      </div>`;
    $("chNew").onclick = () => { C.editGameId = null; go("setup"); };
    $("chStatsAll").onclick = () => { C.stats.game = "all"; C.stats.who = null; go("stats", { gameId: null }); };
    $("chTypes").onclick = () => go("types");
    r.querySelectorAll("[data-g-live]").forEach((b) => (b.onclick = () => go("live", { gameId: b.dataset.gLive, mode: "live" })));
    r.querySelectorAll("[data-g-video]").forEach((b) => (b.onclick = () => go("live", { gameId: b.dataset.gVideo, mode: "video" })));
    r.querySelectorAll("[data-g-stats]").forEach((b) => (b.onclick = () => { C.stats.game = b.dataset.gStats; C.stats.who = null; go("stats", { gameId: b.dataset.gStats }); }));
    r.querySelectorAll("[data-g-edit]").forEach((b) => (b.onclick = () => { C.editGameId = b.dataset.gEdit; go("setup"); }));
    r.querySelectorAll("[data-g-del]").forEach((b) => (b.onclick = async () => {
      const id = b.dataset.gDel;
      if (C.confirmDel !== id) { C.confirmDel = id; renderHome(r); setTimeout(() => { if (C.confirmDel === id) { C.confirmDel = null; if (C.view === "home") renderHome(root()); } }, 4000); return; }
      C.confirmDel = null;
      try { if (C.gameId === id) openGame(null); await FB.deleteGame(id); toast("試合を消しました"); } catch (e) { console.error(e); toast("消せませんでした"); }
    }));
  }

  // ===================== 試合の登録・編集 =====================
  function renderSetup(r) {
    const g = C.editGameId ? C.games.find((x) => x.id === C.editGameId) : null;
    const lu = (g && g.lineup) || { us: [], opp: [] };
    const st = g ? liveOfStatic(g) : initLive();
    const ours = ourPlayers().slice().sort((a, b) => (parseInt(a.number) || 999) - (parseInt(b.number) || 999) || a.name.localeCompare(b.name, "ja"));
    const ourOpts = (sel) => `<option value="">（未設定）</option>` + ours.map((p) => `<option value="${esc(p.uid)}" ${sel === p.uid ? "selected" : ""}>${esc(pname(p))}</option>`).join("");
    const handSel = (id, val, both) => `<select class="ch-hand" id="${id}" aria-label="左右"><option value="R" ${val === "R" ? "selected" : ""}>右</option><option value="L" ${val === "L" ? "selected" : ""}>左</option>${both ? `<option value="S" ${val === "S" ? "selected" : ""}>両</option>` : ""}</select>`;
    const ourRow = (i) => { const p = lu.us[i]; const pl = p && ours.find((x) => x.uid === p.pid); return `<div class="ch-lrow"><span class="ch-no">${i + 1}</span><select id="usB${i}" class="grow" aria-label="${i + 1}番">${ourOpts(p && p.pid)}</select>${handSel("usBh" + i, (p && p.hand) || (pl && pl.bats) || "R", true)}</div>`; };
    const oppRow = (i) => { const p = lu.opp[i]; return `<div class="ch-lrow"><span class="ch-no">${i + 1}</span><input type="text" id="opB${i}n" class="ch-num" inputmode="numeric" maxlength="4" placeholder="背番号" value="${esc((p && p.number) || "")}"><input type="text" id="opB${i}" class="grow" list="chOppList" maxlength="40" placeholder="名前" value="${esc((p && p.name) || "")}">${handSel("opBh" + i, (p && p.hand) || "R", true)}</div>`; };
    const up = st.pitcher.us, op = st.pitcher.opp;
    r.innerHTML = `
      <div class="card">
        <div class="row"><button class="btn small ghost" id="chBack" type="button">← 戻る</button><h2 class="grow">${g ? "試合を編集" : "新しい試合"}</h2></div>
        <div class="grid2">
          <label class="field">日付<input type="date" id="chDate" value="${esc((g && g.date) || todayStr())}"></label>
          <label class="field">相手チーム<input type="text" id="chOpp" list="chTeamList" maxlength="40" placeholder="例：〇〇大学" value="${esc((g && g.opponent) || "")}"></label>
        </div>
        <datalist id="chTeamList">${teams().map((t) => `<option value="${esc(t)}">`).join("")}</datalist>
        <label class="field">メモ（大会名・球場など）<input type="text" id="chMemo" maxlength="60" placeholder="例：新人戦 1回戦" value="${esc((g && g.memo) || "")}"></label>
        <div class="row"><span class="small muted">自チームは</span>
          <div class="seg" role="radiogroup" aria-label="先攻・後攻">
            <label><input type="radio" name="chTop" value="1" ${!g || g.usTop ? "checked" : ""}><span>先攻</span></label>
            <label><input type="radio" name="chTop" value="0" ${g && !g.usTop ? "checked" : ""}><span>後攻</span></label>
          </div></div>
      </div>
      <div class="card">
        <h2>自チーム</h2>
        <div class="ch-lrow"><span class="ch-no">投</span><select id="usP" class="grow" aria-label="先発投手">${ourOpts(up && up.pid)}</select>${handSel("usPh", (up && up.hand) || "R", false)}</div>
        ${[...Array(9).keys()].map(ourRow).join("")}
        <div class="row"><input type="text" id="chAddOur" maxlength="40" placeholder="名簿にいない選手を追加（例：12 山田）" class="grow"><button class="btn small" id="chAddOurBtn" type="button">追加</button></div>
      </div>
      <div class="card">
        <h2>相手チーム</h2>
        <div class="ch-lrow"><span class="ch-no">投</span><input type="text" id="opPn" class="ch-num" inputmode="numeric" maxlength="4" placeholder="背番号" value="${esc((op && op.number) || "")}"><input type="text" id="opP" class="grow" list="chOppList" maxlength="40" placeholder="先発投手の名前" value="${esc((op && op.name) || "")}">${handSel("opPh", (op && op.hand) || "R", false)}</div>
        ${[...Array(9).keys()].map(oppRow).join("")}
        <datalist id="chOppList"></datalist>
      </div>
      <div class="card"><button class="btn red block" id="chSave" type="button">${g ? "保存する" : "登録して入力をはじめる"}</button></div>`;
    const fillOppList = () => { const t = $("chOpp").value.trim(); $("chOppList").innerHTML = oppPlayers(t).map((p) => `<option value="${esc(p.name)}">${esc(p.number ? "#" + p.number : "")}</option>`).join(""); };
    fillOppList(); $("chOpp").addEventListener("input", fillOppList);
    // 相手の名前を入れたら、名簿にある背番号と左右を入れる
    const autofill = (nameId, numId, handId, isP) => $(nameId).addEventListener("change", () => {
      const p = oppPlayers($("chOpp").value.trim()).find((x) => x.name === $(nameId).value.trim()); if (!p) return;
      if (!$(numId).value && p.number) $(numId).value = p.number;
      const h = isP ? p.throws : p.bats; if (h) $(handId).value = h;
    });
    autofill("opP", "opPn", "opPh", true); for (let i = 0; i < 9; i++) autofill("opB" + i, "opB" + i + "n", "opBh" + i, false);
    // 自チームの選手を選んだら、名簿の左右を入れる
    const ourAuto = (selId, handId, isP) => $(selId).addEventListener("change", () => { const p = ours.find((x) => x.uid === $(selId).value); const h = p && (isP ? p.throws : p.bats); if (h) $(handId).value = h; });
    ourAuto("usP", "usPh", true); for (let i = 0; i < 9; i++) ourAuto("usB" + i, "usBh" + i, false);
    $("chBack").onclick = () => go("home");
    $("chAddOurBtn").onclick = async () => {
      const v = $("chAddOur").value.trim(); if (!v) return;
      const m = v.match(/^#?(\d{1,4})\s+(.+)$/); const number = m ? m[1] : "", name = (m ? m[2] : v).trim();
      try { await FB.addPlayer(name, { number }); toast(`${name}さんを追加しました`); $("chAddOur").value = ""; setTimeout(() => renderSetup(r), 400); } catch (e) { toast("追加できませんでした"); }
    };
    $("chSave").onclick = async () => {
      const opponent = $("chOpp").value.trim(), date = $("chDate").value || todayStr();
      if (!opponent) { toast("相手チームの名前を入れてください"); $("chOpp").focus(); return; }
      $("chSave").disabled = true;
      try {
        // 自チーム：選んだ選手。左右が名簿と違えば名簿も直す
        const ourRef = async (selId, handId, isP) => {
          const p = ours.find((x) => x.uid === $(selId).value); if (!p) return null;
          const h = $(handId).value, key = isP ? "throws" : "bats";
          if (p[key] !== h) FB.updatePlayer(p.uid, { [key]: h }).catch(() => {});
          return ref(p, h);
        };
        // 相手：名前が名簿になければ追加する
        const oppRef = async (nameId, numId, handId, isP) => {
          const name = $(nameId).value.trim(); if (!name) return null;
          const number = $(numId).value.trim(), h = $(handId).value, key = isP ? "throws" : "bats";
          let p = oppPlayers(opponent).find((x) => x.name === name);
          if (!p) { const uid = await FB.addPlayer(name, { team: opponent, number, [key]: h }); p = { uid, name, number, team: opponent }; }
          else { const patch = {}; if (number && p.number !== number) patch.number = number; if (p[key] !== h) patch[key] = h; if (Object.keys(patch).length) FB.updatePlayer(p.uid, patch).catch(() => {}); }
          return { pid: p.uid, name, number: number || p.number || "", hand: h };
        };
        const lineup = { us: [], opp: [] };
        for (let i = 0; i < 9; i++) { lineup.us.push(await ourRef("usB" + i, "usBh" + i, false)); lineup.opp.push(await oppRef("opB" + i, "opB" + i + "n", "opBh" + i, false)); }
        const usP = await ourRef("usP", "usPh", true), oppP = await oppRef("opP", "opPn", "opPh", true);
        const meta = { date, opponent, memo: $("chMemo").value.trim(), usTop: document.querySelector('input[name="chTop"]:checked').value === "1", lineup, updatedAt: new Date().toISOString() };
        if (g) {
          const live = clone(g.live || initLive()); live.pitcher = live.pitcher || {};
          if (usP && (!live.pitcher.us || C.pitches.length === 0)) live.pitcher.us = usP;
          if (oppP && (!live.pitcher.opp || C.pitches.length === 0)) live.pitcher.opp = oppP;
          await FB.updateGame(g.id, { ...meta, live });
          toast("保存しました"); go("home");
        } else {
          const id = await FB.addGame({ ...meta, live: initLive(usP, oppP), createdAt: new Date().toISOString() });
          toast("試合を登録しました"); go("live", { gameId: id, mode: "live" });
        }
      } catch (e) { console.error(e); toast("保存できませんでした。通信状態を確認してください"); }
      finally { const b = $("chSave"); if (b) b.disabled = false; }
    };
  }
  const liveOfStatic = (g) => (g.live ? clone(g.live) : initLive());

  // ===================== 入力画面 =====================
  async function saveLive(g, s) {
    g.live = s; // 画面はすぐ更新する（電波が悪くても、送信は裏で続く）
    FB.updateGame(g.id, { live: s, date: g.date, opponent: g.opponent, updatedAt: new Date().toISOString() }).catch((e) => { console.error(e); toast("保存できませんでした"); });
  }
  function renderLive(r, soft) {
    const g = game();
    if (!g) { r.innerHTML = `<div class="card"><p class="small muted">試合を読み込んでいます…</p><button class="btn small" id="chBack">← 一覧へ</button></div>`; $("chBack").onclick = () => go("home"); return; }
    const s = liveOf(g);
    if (soft && r.querySelector("#clStatus")) { updateLiveParts(g, s); return; }
    const video = C.mode === "video";
    const showTypes = video || pref.get("chartTypes", false);
    r.innerHTML = `
      ${video ? `
      <div class="card cl-video">
        <div class="row"><button class="btn small ghost" id="chBack" type="button">← 一覧</button><b class="grow">動画で入力</b>
          <label class="btn small"><input type="file" id="clFile" accept="video/*" hidden>動画を開く</label></div>
        <div class="stage" id="clStage" style="aspect-ratio:16/9"><video id="clVideo" playsinline muted controls style="width:100%;height:100%;object-fit:contain;background:#000"></video></div>
        <div class="controls">
          <button class="btn small" data-vs="-5">-5秒</button><button class="btn small" data-vs="-1">-1秒</button><button class="btn small" data-vs="-0.033">◀コマ</button>
          <button class="btn small primary" id="clPlay">再生</button>
          <button class="btn small" data-vs="0.033">コマ▶</button><button class="btn small" data-vs="1">+1秒</button><button class="btn small" data-vs="5">+5秒</button>
          <button class="btn small" id="clRate">0.5倍</button>
        </div>
      </div>` : ""}
      <div class="card cl-status" id="clStatus"></div>
      <div class="card cl-input">
        ${video ? `<div id="clEditHead" class="small"></div>` : ""}
        <div id="clTypesBox" ${showTypes ? "" : "hidden"}>
          <div class="cl-types" id="clTypes"></div>
          <div class="cl-zonebox">
            <canvas id="clZone" class="cl-zone" aria-label="コース。タップして入力"></canvas>
            <div class="stack" style="gap:8px">
              <label class="field">球速<input type="text" id="clSpeed" inputmode="numeric" maxlength="3" placeholder="km/h" autocomplete="off"></label>
              <button class="btn small ghost" id="clZoneClear" type="button">コースを消す</button>
              <div class="seg cl-view" role="radiogroup" aria-label="コースの向き">
                <label><input type="radio" name="clView" value="P" ${zoneView() === "P" ? "checked" : ""}><span>投手目線</span></label>
                <label><input type="radio" name="clView" value="C" ${zoneView() === "C" ? "checked" : ""}><span>捕手目線</span></label>
              </div>
            </div>
          </div>
        </div>
        <div class="cl-results" id="clResults">${RESULTS.map((x) => `<button class="btn ${x.cls}" data-res="${x.id}" type="button">${x.label}</button>`).join("")}</div>
        <div class="controls" id="clEditBtns" hidden><button class="btn red" id="clEditSave" type="button">この球を保存して次へ</button><button class="btn ghost" id="clEditCancel" type="button">やめる</button></div>
        <div class="controls">
          <button class="btn small" id="clUndo" type="button">1球取り消し</button>
          <button class="btn small" id="clAdjust" type="button">手で直す・交代</button>
          ${video ? "" : `<label class="row small"><input type="checkbox" id="clShowTypes" ${showTypes ? "checked" : ""}> 球種・コースも入れる</label>`}
        </div>
        <div id="clAdjustBox" hidden></div>
        <div class="cl-pa" id="clPA"></div>
      </div>
      ${video ? `<div class="card cl-listcard"><h2>投球一覧</h2><div class="cl-list" id="clList"></div></div>` : `
      <div class="card"><div class="row"><button class="btn small ghost" id="chBack" type="button">← 一覧</button><span class="small muted grow" id="clSync"></span><button class="btn small" id="clGoStats" type="button">集計</button></div></div>`}
      <div class="sheet-back" id="clSheet" hidden></div>`;
    $("chBack").onclick = () => { stopVideo(); go("home"); };
    if ($("clGoStats")) $("clGoStats").onclick = () => { C.stats.game = g.id; go("stats"); };
    if ($("clShowTypes")) $("clShowTypes").onchange = (e) => { pref.set("chartTypes", e.target.checked); $("clTypesBox").hidden = !e.target.checked; drawZoneInput(); };
    $("clSpeed").oninput = (e) => { C.sel.speed = e.target.value.replace(/\D/g, ""); };
    $("clZoneClear").onclick = () => { C.sel.zone = null; drawZoneInput(); };
    $("clZone").addEventListener("pointerdown", onZoneTap);
    r.querySelectorAll('input[name="clView"]').forEach((x) => (x.onchange = () => { pref.set("chartZoneView", x.value); drawZoneInput(); }));
    r.querySelectorAll("[data-res]").forEach((b) => (b.onclick = () => onResult(b.dataset.res)));
    $("clUndo").onclick = onUndo;
    $("clAdjust").onclick = () => { const box = $("clAdjustBox"); box.hidden = !box.hidden; if (!box.hidden) renderAdjust(); };
    $("clEditSave").onclick = saveEdit;
    $("clEditCancel").onclick = () => { C.sel = { typeId: null, zone: null, speed: "", editId: null }; updateLiveParts(game(), liveOf(game())); };
    if (video) setupVideo();
    updateLiveParts(g, s);
  }
  function updateLiveParts(g, s) {
    const bt = batTeam(g, s), ft = fieldTeam(g, s), b = curBatter(g, s), p = curPitcher(g, s);
    const pc = p ? C.pitches.filter((x) => x.pTeam === ft && (p.pid ? x.pitcherId === p.pid : x.pitcherName === p.name)).length : 0;
    const dots = (n, max, cls) => [...Array(max)].map((_, i) => `<i class="${i < n ? cls : ""}"></i>`).join("");
    const runs = (t) => (s.runs[t] || []).reduce((a, v) => a + (v || 0), 0);
    const usFirst = !!g.usTop, scoreTxt = `${usFirst ? "自" : esc(g.opponent || "相手")} ${runs(usFirst ? "us" : "opp")} - ${runs(usFirst ? "opp" : "us")} ${usFirst ? esc(g.opponent || "相手") : "自"}`;
    $("clStatus").innerHTML = `
      <div class="cl-top">
        <b class="cl-inning">${halfLabel(s)}</b>
        <span class="cl-bso"><span>B</span>${dots(s.balls, 3, "b")}<span>S</span>${dots(s.strikes, 2, "s")}<span>O</span>${dots(s.outs, 2, "o")}</span>
        <span class="small mono">${scoreTxt}</span>
      </div>
      <button class="cl-who" id="clWhoP" type="button"><span class="cl-tag">投</span><b>${p ? esc(pname(p)) : "未設定（タップ）"}</b><span class="small muted">${p && p.hand ? HAND[p.hand] + "投" : ""}・${pc}球・${esc(teamName(g, ft))}</span></button>
      <button class="cl-who" id="clWhoB" type="button"><span class="cl-tag">打</span><b>${s.slot[bt] + 1}番 ${b ? esc(pname(b)) : "未設定（タップ）"}</b><span class="small muted">${b && b.hand ? HAND[b.hand] + "打" : ""}・${esc(teamName(g, bt))}</span></button>`;
    $("clWhoP").onclick = () => openPicker("pitcher");
    $("clWhoB").onclick = () => openPicker("batter");
    // 球種ボタン
    const editing = C.sel.editId ? C.pitches.find((x) => x.id === C.sel.editId) : null;
    $("clTypes").innerHTML = visibleTypes().map((t) => `<button type="button" class="cl-type ${C.sel.typeId === t.id ? "on" : ""}" data-type="${esc(t.id)}" style="--tc:${typeColor(t.id)}">${esc(t.name)}</button>`).join("");
    $("clTypes").querySelectorAll("[data-type]").forEach((x) => (x.onclick = () => { C.sel.typeId = C.sel.typeId === x.dataset.type ? null : x.dataset.type; $("clTypes").querySelectorAll(".cl-type").forEach((y) => y.classList.toggle("on", y.dataset.type === C.sel.typeId)); drawZoneInput(); }));
    if ($("clSpeed").value !== C.sel.speed) $("clSpeed").value = C.sel.speed;
    // 動画モード：選んだ球を直しているとき
    $("clResults").hidden = !!editing; $("clEditBtns").hidden = !editing;
    if ($("clEditHead")) $("clEditHead").innerHTML = editing ? `<span class="chip turf">修正中</span> ${esc(halfLabel(editing))}・${esc(editing.batterName || "")}・${editing.balls}-${editing.strikes}・${RES_LABEL[editing.result]}${editing.paResult ? "（" + PA_LABEL[editing.paResult] + "）" : ""}` : "";
    // この打席の球
    const lastPAStart = (() => { let i = C.pitches.length - 1; while (i >= 0 && !C.pitches[i].paEnd) i--; return i + 1; })();
    const cur = C.pitches.slice(lastPAStart);
    const lastPA = lastPAStart > 0 ? C.pitches[lastPAStart - 1] : null;
    $("clPA").innerHTML = (cur.length ? `<div class="small muted">この打席</div><div class="chips">${cur.map((x, i) => `<span class="chip" style="border-color:${x.typeId ? typeColor(x.typeId) : "var(--line)"}">${i + 1} ${esc(typeName(x) || "")} ${RES_LABEL[x.result]}${x.speed ? " " + x.speed : ""}</span>`).join("")}</div>` : "")
      + (lastPA ? `<div class="small muted">前の打席：${esc(lastPA.batterName || "")} ${PA_LABEL[lastPA.paResult] || ""}${lastPA.bbPos ? "（" + posLabel(lastPA.bbPos) + "）" : ""}</div>` : "");
    if ($("clSync")) $("clSync").textContent = C.pending ? `未送信 ${C.pending}球（電波が戻ると自動で送ります）` : `${C.pitches.length}球 入力済み`;
    if ($("clList")) renderPitchList();
    drawZoneInput();
  }
  // ---------- コース（捕手から見た図） ----------
  const ZR = { xr: 2.3, yr: 2.1 }; // 表示する範囲（ストライクゾーンの半分の幅＝1）
  function zoneMap(cv) {
    const { w, h, dpr } = sizeCanvas(cv);
    const zw = w / (2 * ZR.xr), zh = h / (2 * ZR.yr), cx = w / 2, cy = h / 2;
    return { w, h, dpr, X: (x) => cx + x * zw, Y: (y) => cy - y * zh, ix: (px) => (px - cx) / zw, iy: (py) => (cy - py) / zh };
  }
  function drawZoneBase(cv, bats, view = "P") {
    const m = zoneMap(cv), ctx = cv.getContext("2d"), { w, h, dpr, X, Y } = m;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = css("--surface-2"); ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = css("--turf-soft"); ctx.fillRect(X(-1), Y(1), X(1) - X(-1), Y(-1) - Y(1));
    ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1 * dpr;
    for (let i = 1; i < 3; i++) { const x = -1 + (2 * i) / 3, y = -1 + (2 * i) / 3; ctx.beginPath(); ctx.moveTo(X(x), Y(1)); ctx.lineTo(X(x), Y(-1)); ctx.moveTo(X(-1), Y(y)); ctx.lineTo(X(1), Y(y)); ctx.stroke(); }
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = css("--ink"); ctx.strokeRect(X(-1), Y(1), X(1) - X(-1), Y(-1) - Y(1));
    // 打者の立つ側（投手から見ると右打者は右側、捕手から見ると左側）
    if (bats === "R" || bats === "L") {
      ctx.fillStyle = css("--muted"); ctx.font = `700 ${11 * dpr}px ${css("--font-body")}`; ctx.textAlign = "center";
      const right = (bats === "R") === (view === "P");
      const x = right ? X(1.75) : X(-1.75);
      ctx.fillText(bats === "R" ? "右打者" : "左打者", x, Y(1.85));
      ctx.fillRect(x - 3 * dpr, Y(1.2), 6 * dpr, Y(-1.6) - Y(1.2));
    }
    return m;
  }
  function drawDot(ctx, m, x, y, color, label, r = 9) {
    const { dpr, X, Y } = m;
    ctx.beginPath(); ctx.arc(X(x), Y(y), r * dpr, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = "#ffffff"; ctx.stroke();
    if (label) { ctx.fillStyle = "#ffffff"; ctx.font = `700 ${10 * dpr}px ${css("--font-mono")}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(label, X(x), Y(y) + 0.5 * dpr); ctx.textBaseline = "alphabetic"; }
  }
  function drawZoneInput() {
    const cv = $("clZone"); if (!cv || $("clTypesBox").hidden) return;
    const g = game(); if (!g) return;
    const editing = C.sel.editId ? C.pitches.find((x) => x.id === C.sel.editId) : null;
    const s = liveOf(g);
    const bats = editing ? editing.bBats : effBats(curBatter(g, s), curPitcher(g, s));
    const v = zoneView(), sx = v === "P" ? 1 : -1;
    const m = drawZoneBase(cv, bats, v), ctx = cv.getContext("2d");
    // この打席の球（直しているときは、その打席のそれより前の球）
    let list;
    if (editing) { const i = C.pitches.indexOf(editing); let j = i - 1; while (j >= 0 && !C.pitches[j].paEnd) j--; list = C.pitches.slice(j + 1, i); }
    else { let j = C.pitches.length - 1; while (j >= 0 && !C.pitches[j].paEnd) j--; list = C.pitches.slice(j + 1); }
    list.forEach((x, i) => { if (isNum(x.zx)) drawDot(ctx, m, sx * zxP(x), x.zy, typeColor(x.typeId), String(i + 1), 8); });
    if (C.sel.zone) {
      const col = C.sel.typeId ? typeColor(C.sel.typeId) : css("--ink");
      drawDot(ctx, m, sx * C.sel.zone.x, C.sel.zone.y, col, String(list.length + 1), 11);
      ctx.beginPath(); ctx.arc(m.X(sx * C.sel.zone.x), m.Y(C.sel.zone.y), 15 * m.dpr, 0, Math.PI * 2); ctx.strokeStyle = col; ctx.lineWidth = 2 * m.dpr; ctx.stroke();
    }
  }
  function onZoneTap(e) {
    const cv = $("clZone"), r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const m = zoneMap(cv);
    const x = m.ix((e.clientX - r.left) * dpr), y = m.iy((e.clientY - r.top) * dpr);
    const sx = zoneView() === "P" ? 1 : -1;
    C.sel.zone = { x: Math.max(-ZR.xr, Math.min(ZR.xr, Math.round(sx * x * 100) / 100)), y: Math.max(-ZR.yr, Math.min(ZR.yr, Math.round(y * 100) / 100)) };
    drawZoneInput();
  }

  // ---------- 1球の保存 ----------
  function onResult(res) {
    const g = game(); if (!g) return;
    const showTypes = C.mode === "video" || pref.get("chartTypes", false);
    if (showTypes && !C.sel.typeId) {
      // 球種はなくても保存できるが、入れ忘れに気づけるように一度だけ知らせる
      if (!C.warnedType) { C.warnedType = true; toast("球種が選ばれていません。もう一度押すと球種なしで保存します"); setTimeout(() => { C.warnedType = false; }, 3000); return; }
    }
    C.warnedType = false;
    if (res === "X") return openBattedSheet((bb) => savePitch(g, res, bb));
    savePitch(g, res, null);
  }
  function savePitch(g, res, bb) {
    const pre = liveOf(g), bt = batTeam(g, pre), ft = fieldTeam(g, pre), b = curBatter(g, pre), p = curPitcher(g, pre);
    const out = advance(g, pre, res, bb && bb.res);
    const t = C.sel.typeId ? typeById(C.sel.typeId) : null;
    const vt = C.mode === "video" && C.videoEl && C.video.url ? Math.round(C.videoEl.currentTime * 100) / 100 : null;
    const doc = {
      gameId: g.id, seq: pre.seq, date: g.date || "", opponent: g.opponent || "",
      inning: pre.inning, half: pre.half, outs: pre.outs, balls: pre.balls, strikes: pre.strikes,
      bTeam: bt, pTeam: ft, slot: pre.slot[bt],
      pitcherId: (p && p.pid) || "", pitcherName: (p && p.name) || "", pitcherNo: (p && p.number) || "", pThrows: (p && p.hand) || "",
      batterId: (b && b.pid) || "", batterName: (b && b.name) || "", batterNo: (b && b.number) || "", bBats: effBats(b, p), bHand: (b && b.hand) || "",
      typeId: t ? t.id : "", typeName: t ? t.name : "", speed: C.sel.speed ? +C.sel.speed : null,
      zx: C.sel.zone ? C.sel.zone.x : null, zy: C.sel.zone ? C.sel.zone.y : null, zview: "P",
      result: res, bbType: (bb && bb.type) || "", bbPos: (bb && bb.pos) || "", bbX: bb && isNum(bb.x) ? bb.x : null, bbY: bb && isNum(bb.y) ? bb.y : null, bbRes: (bb && bb.res) || "",
      paEnd: out.paEnd, paResult: out.pa || "", outsAdded: out.outs,
      pre: JSON.stringify(pre), at: Date.now(), vt, by: (Store.me && Store.me.uid) || "",
    };
    const id = `${g.id}_${String(pre.seq).padStart(4, "0")}`;
    // 画面はすぐ進める（電波が悪いときも、送信は裏で続く）
    C.pitches = C.pitches.filter((x) => x.id !== id).concat([{ id, ...doc }]).sort((a, c) => a.seq - c.seq);
    FB.addPitch(id, doc).catch((e) => { console.error(e); toast("この球を保存できませんでした。通信状態を確認してください"); });
    saveLive(g, out.s);
    if (out.paEnd) toast(`${doc.batterName || "打者"}：${PA_LABEL[out.pa]}${doc.bbPos ? "（" + posLabel(doc.bbPos) + "）" : ""}`);
    if (out.s.half !== pre.half) toast(`チェンジ（${halfLabel(out.s)}へ）`);
    C.sel = { typeId: null, zone: null, speed: "", editId: null };
    if (navigator.vibrate) try { navigator.vibrate(15); } catch (e) { /* なし */ }
    updateLiveParts(g, out.s);
  }
  function onUndo() {
    const g = game(); if (!g || !C.pitches.length) { toast("取り消す球がありません"); return; }
    const last = C.pitches[C.pitches.length - 1];
    if (!C.confirmUndo) { C.confirmUndo = true; $("clUndo").textContent = "本当に取り消す"; setTimeout(() => { C.confirmUndo = false; const b = $("clUndo"); if (b) b.textContent = "1球取り消し"; }, 3000); return; }
    C.confirmUndo = false; $("clUndo").textContent = "1球取り消し";
    let pre; try { pre = JSON.parse(last.pre); } catch (e) { pre = null; }
    C.pitches = C.pitches.filter((x) => x.id !== last.id);
    FB.deletePitch(last.id).catch(() => toast("取り消せませんでした"));
    if (pre) { pre.runs = (g.live && g.live.runs) || pre.runs; saveLive(g, pre); }
    toast(`取り消しました（${RES_LABEL[last.result]}）`);
    updateLiveParts(g, liveOf(g));
  }
  // ---------- 打球の入力（種類・方向・結果） ----------
  function openBattedSheet(done) {
    const sh = $("clSheet"); const bb = { type: "", x: null, y: null, pos: "", res: "" };
    sh.hidden = false;
    sh.innerHTML = `<div class="sheet-panel" role="dialog" aria-label="打球">
      <div class="row"><b class="grow">打球</b><button class="btn small ghost" id="bbClose" type="button">やめる</button></div>
      <div class="cl-chips" id="bbTypes">${BB_TYPES.map(([id, l]) => `<button type="button" class="cl-type" data-bbt="${id}">${l}</button>`).join("")}</div>
      <div class="cl-pos" id="bbPos">${POS.map(([id, l]) => `<button type="button" class="cl-type" data-bbp="${id}">${l}</button>`).join("")}</div>
      <canvas id="bbField" class="cl-field" aria-label="打球の方向。タップして入力"></canvas>
      <div class="cl-chips" id="bbRes">${BB_RES.map(([id, l]) => `<button type="button" class="btn ${HITS.includes(id) ? "turf" : ""}" data-bbr="${id}">${l}</button>`).join("")}</div>
    </div>`;
    const close = () => { sh.hidden = true; sh.innerHTML = ""; };
    $("bbClose").onclick = close;
    sh.onclick = (e) => { if (e.target === sh) close(); };
    sh.querySelectorAll("[data-bbt]").forEach((b) => (b.onclick = () => { bb.type = b.dataset.bbt; sh.querySelectorAll("[data-bbt]").forEach((x) => x.classList.toggle("on", x === b)); }));
    const draw = () => { drawField($("bbField"), bb.x !== null ? [{ x: bb.x, y: bb.y, color: css("--accent") }] : []); sh.querySelectorAll("[data-bbp]").forEach((x) => x.classList.toggle("on", x.dataset.bbp === bb.pos)); };
    sh.querySelectorAll("[data-bbp]").forEach((b) => (b.onclick = () => { const q = POS.find((x) => x[0] === b.dataset.bbp); bb.pos = q[0]; bb.x = q[2]; bb.y = q[3]; draw(); }));
    $("bbField").addEventListener("pointerdown", (e) => {
      const cv = $("bbField"), r = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2.5), m = fieldMap(cv);
      bb.x = Math.round(m.ix((e.clientX - r.left) * dpr) * 1000) / 1000; bb.y = Math.round(m.iy((e.clientY - r.top) * dpr) * 1000) / 1000; bb.pos = nearestPos(bb.x, bb.y); draw();
    });
    sh.querySelectorAll("[data-bbr]").forEach((b) => (b.onclick = () => { bb.res = b.dataset.bbr; close(); done(bb); }));
    requestAnimationFrame(draw);
  }
  // グラウンド：本塁を原点、外野フェンスまでを1とする
  function fieldMap(cv) {
    const { w, h, dpr } = sizeCanvas(cv);
    const R = Math.min(h * 0.88, w * 0.68), hx = w / 2, hy = h * 0.95;
    return { w, h, dpr, R, X: (x) => hx + x * R, Y: (y) => hy - y * R, ix: (px) => (px - hx) / R, iy: (py) => (hy - py) / R };
  }
  function drawField(cv, pts) {
    if (!cv) return;
    const m = fieldMap(cv), ctx = cv.getContext("2d"), { w, h, dpr, X, Y } = m;
    ctx.clearRect(0, 0, w, h);
    const a = Math.PI / 4;
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(-Math.sin(a)), Y(Math.cos(a)));
    for (let t = -a; t <= a + 1e-6; t += a / 20) ctx.lineTo(X(Math.sin(t)), Y(Math.cos(t)));
    ctx.closePath(); ctx.fillStyle = css("--turf-soft"); ctx.fill(); ctx.strokeStyle = css("--turf"); ctx.lineWidth = 1.5 * dpr; ctx.stroke();
    const d = 0.3; // 塁間（フェンスまでの約3割）
    ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(d * Math.sin(a)), Y(d * Math.cos(a))); ctx.lineTo(X(0), Y(2 * d * Math.cos(a))); ctx.lineTo(X(-d * Math.sin(a)), Y(d * Math.cos(a))); ctx.closePath();
    ctx.fillStyle = css("--surface-2"); ctx.fill(); ctx.strokeStyle = css("--muted"); ctx.lineWidth = 1 * dpr; ctx.stroke();
    ctx.beginPath(); for (let t = -a; t <= a + 1e-6; t += a / 20) { const rr = 0.52; const fx = X(rr * Math.sin(t)), fy = Y(rr * Math.cos(t)); if (t === -a) ctx.moveTo(fx, fy); else ctx.lineTo(fx, fy); } ctx.setLineDash([3 * dpr, 4 * dpr]); ctx.stroke(); ctx.setLineDash([]);
    for (const p of pts) { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), (p.r || 6) * dpr, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill(); ctx.lineWidth = 1.2 * dpr; ctx.strokeStyle = "#ffffff"; ctx.stroke(); }
  }

  // ---------- 手で直す・交代 ----------
  function renderAdjust() {
    const g = game(), box = $("clAdjustBox"); if (!g || !box) return;
    box.innerHTML = `
      <div class="cl-adjust">
        <div class="row small"><span class="cl-al">ボール</span><button class="btn small" data-adj="balls:-1">−</button><button class="btn small" data-adj="balls:1">＋</button>
          <span class="cl-al">ストライク</span><button class="btn small" data-adj="strikes:-1">−</button><button class="btn small" data-adj="strikes:1">＋</button></div>
        <div class="row small"><span class="cl-al">アウト</span><button class="btn small" data-adj="outs:-1">−</button><button class="btn small" data-adj="outs:1">＋（盗塁死など）</button></div>
        <div class="row small"><span class="cl-al">イニング</span><button class="btn small" data-adj="half:-1">◀ 前へ</button><button class="btn small" data-adj="half:1">次へ ▶</button></div>
        <div class="row small"><span class="cl-al">打順</span><button class="btn small" data-adj="slot:-1">◀ 前の打者</button><button class="btn small" data-adj="slot:1">次の打者 ▶</button></div>
        <div class="row small"><span class="cl-al">得点</span><button class="btn small" data-adj="run:-1">−1</button><button class="btn small turf" data-adj="run:1">＋1（攻撃中のチーム）</button></div>
        <div class="row small"><button class="btn small" id="adjPitcher">投手を交代</button><button class="btn small" id="adjBatter">代打・打者を変更</button></div>
      </div>`;
    box.querySelectorAll("[data-adj]").forEach((b) => (b.onclick = () => {
      const [k, d] = b.dataset.adj.split(":"), dv = +d, g2 = game(), s = liveOf(g2), bt = batTeam(g2, s);
      if (k === "balls") s.balls = Math.max(0, Math.min(3, s.balls + dv));
      if (k === "strikes") s.strikes = Math.max(0, Math.min(2, s.strikes + dv));
      if (k === "outs") { s.outs = Math.max(0, s.outs + dv); if (s.outs >= 3) { nextHalf(s); toast(`チェンジ（${halfLabel(s)}へ）`); } }
      if (k === "half") (dv > 0 ? nextHalf : prevHalf)(s);
      if (k === "slot") { s.slot[bt] = (s.slot[bt] + dv + 9) % 9; s.balls = 0; s.strikes = 0; }
      if (k === "run") { const arr = s.runs[bt] = s.runs[bt] || []; const i = s.inning - 1; while (arr.length <= i) arr.push(0); arr[i] = Math.max(0, (arr[i] || 0) + dv); }
      saveLive(g2, s); updateLiveParts(g2, s);
    }));
    $("adjPitcher").onclick = () => openPicker("pitcher");
    $("adjBatter").onclick = () => openPicker("batter");
  }
  // 投手・打者を選ぶ（交代・代打。相手の選手はその場で追加できる）
  function openPicker(kind) {
    const g = game(); if (!g) return;
    const s = liveOf(g), team = kind === "pitcher" ? fieldTeam(g, s) : batTeam(g, s);
    const list = team === "us" ? ourPlayers() : oppPlayers(g.opponent);
    const cur = kind === "pitcher" ? curPitcher(g, s) : curBatter(g, s);
    const sh = $("clSheet"); sh.hidden = false;
    const sorted = list.slice().sort((a, b) => (parseInt(a.number) || 999) - (parseInt(b.number) || 999) || a.name.localeCompare(b.name, "ja"));
    sh.innerHTML = `<div class="sheet-panel" role="dialog" aria-label="${kind === "pitcher" ? "投手" : "打者"}を選ぶ">
      <div class="row"><b class="grow">${kind === "pitcher" ? "投手を選ぶ" : `${s.slot[team] + 1}番の打者を選ぶ`}（${esc(teamName(g, team))}）</b><button class="btn small ghost" id="pkClose" type="button">やめる</button></div>
      <div class="row small"><span>${kind === "pitcher" ? "投げる手" : "打つ側"}</span>
        <select id="pkHand" class="ch-hand"><option value="R">右</option><option value="L">左</option>${kind === "batter" ? `<option value="S">両</option>` : ""}</select></div>
      <div class="cl-pick">${sorted.map((p) => `<button type="button" class="btn small ${cur && cur.pid === p.uid ? "primary" : ""}" data-pk="${esc(p.uid)}">${esc(pname(p))}</button>`).join("") || `<span class="small muted">名簿に選手がいません</span>`}</div>
      <div class="row"><input type="text" id="pkNum" class="ch-num" inputmode="numeric" maxlength="4" placeholder="背番号"><input type="text" id="pkName" class="grow" maxlength="40" placeholder="名簿にいない選手の名前"><button class="btn small" id="pkAdd" type="button">追加して選ぶ</button></div>
    </div>`;
    const close = () => { sh.hidden = true; sh.innerHTML = ""; };
    $("pkClose").onclick = close; sh.onclick = (e) => { if (e.target === sh) close(); };
    const key = kind === "pitcher" ? "throws" : "bats";
    if (cur && cur.hand) $("pkHand").value = cur.hand;
    sh.querySelectorAll("[data-pk]").forEach((b) => b.addEventListener("click", () => { const p = list.find((x) => x.uid === b.dataset.pk); if (p && p[key]) $("pkHand").value = p[key]; }, { capture: true }));
    const choose = (pref) => {
      const g2 = game(), s2 = liveOf(g2), h = $("pkHand").value;
      const r = { pid: pref.uid, name: pref.name, number: pref.number || "", hand: pref[key] || h };
      if (kind === "pitcher") { s2.pitcher[team] = r; saveLive(g2, s2); }
      else {
        const lineup = clone(g2.lineup || { us: [], opp: [] }); lineup[team] = lineup[team] || []; while (lineup[team].length < 9) lineup[team].push(null);
        lineup[team][s2.slot[team]] = r; g2.lineup = lineup;
        FB.updateGame(g2.id, { lineup, date: g2.date, opponent: g2.opponent }).catch(() => toast("保存できませんでした"));
      }
      if (pref.uid && pref[key] !== r.hand) FB.updatePlayer(pref.uid, { [key]: r.hand }).catch(() => {});
      close(); updateLiveParts(g2, liveOf(g2)); toast(`${kind === "pitcher" ? "投手" : "打者"}：${pname(r)}`);
    };
    sh.querySelectorAll("[data-pk]").forEach((b) => (b.onclick = () => { const p = list.find((x) => x.uid === b.dataset.pk); if (!p) return; choose({ ...p, [key]: $("pkHand").value }); }));
    $("pkAdd").onclick = async () => {
      const name = $("pkName").value.trim(); if (!name) { $("pkName").focus(); return; }
      const number = $("pkNum").value.trim(), h = $("pkHand").value;
      try {
        const extra = { number, [key]: h }; if (team === "opp") extra.team = g.opponent;
        const uid = await FB.addPlayer(name, extra);
        choose({ uid, name, number, [key]: h });
      } catch (e) { toast("追加できませんでした"); }
    };
  }

  // ---------- 動画で入力 ----------
  function stopVideo() { if (C.videoEl) { try { C.videoEl.pause(); } catch (e) { /* なし */ } } }
  function setupVideo() {
    const v = $("clVideo"); C.videoEl = v;
    if (C.video.url) v.src = C.video.url;
    v.playbackRate = C.video.rate || 1;
    $("clRate").textContent = (C.video.rate || 1) === 1 ? "0.5倍" : "等倍";
    syncMsg();
    $("clFile").onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      if (C.video.url) URL.revokeObjectURL(C.video.url);
      C.video.url = URL.createObjectURL(f); C.video.name = f.name; C.video.size = f.size; v.src = C.video.url;
      await new Promise((res) => { v.onloadedmetadata = res; setTimeout(res, 4000); });
      // 動画の撮影開始時刻（だいたい）。正確には「この球の位置に合わせる」で合わせる
      const saved = pref.get(syncKey(), null);
      if (saved && isNum(saved.t0)) C.video.t0 = saved.t0;
      else C.video.t0 = (await creationTime(f)) || (f.lastModified && isFinite(v.duration) ? f.lastModified - v.duration * 1000 : null);
      C.video.synced = !!saved;
      syncMsg();
    };
    $("clPlay").onclick = () => { if (v.paused) v.play().catch(() => {}); else v.pause(); };
    v.onplay = () => { $("clPlay").textContent = "止める"; }; v.onpause = () => { $("clPlay").textContent = "再生"; };
    document.querySelectorAll("[data-vs]").forEach((b) => (b.onclick = () => { v.pause(); v.currentTime = Math.max(0, v.currentTime + +b.dataset.vs); }));
    $("clRate").onclick = () => { C.video.rate = (C.video.rate || 1) === 1 ? 0.5 : 1; v.playbackRate = C.video.rate; $("clRate").textContent = C.video.rate === 1 ? "0.5倍" : "等倍"; };
  }
  const syncKey = () => `chartSync:${C.gameId}:${C.video.name}:${C.video.size}`;
  function syncMsg() {
    const b = $("clSync1"); if (!b) return;
    b.classList.toggle("primary", !!C.video.url && !C.video.synced && C.pitches.some((p) => p.at && !isNum(p.vt)));
  }
  // mp4の中の撮影時刻を読む（読めないときは null）
  async function creationTime(f) {
    try {
      if (typeof MP4Box !== "object") return null;
      const mp4 = MP4Box.createFile(); let info = null; mp4.onReady = (i) => { info = i; };
      const head = await f.slice(0, Math.min(f.size, 2 * 1024 * 1024)).arrayBuffer(); head.fileStart = 0; mp4.appendBuffer(head);
      if (!info && f.size > 2 * 1024 * 1024) { const tail = await f.slice(Math.max(0, f.size - 4 * 1024 * 1024)).arrayBuffer(); tail.fileStart = Math.max(0, f.size - 4 * 1024 * 1024); mp4.appendBuffer(tail); }
      const c = info && info.created && info.created.getTime();
      return c && c > 1.5e12 ? c : null;
    } catch (e) { return null; }
  }
  const pitchVideoTime = (p) => (isNum(p.vt) ? p.vt : p.at && isNum(C.video.t0) ? (p.at - C.video.t0) / 1000 : null);
  function renderPitchList() {
    const el = $("clList"); if (!el) return;
    if (!C.pitches.length) { el.innerHTML = `<p class="small muted">まだ球がありません</p>`; return; }
    let lastHalf = "";
    el.innerHTML = C.pitches.map((p) => {
      const h = halfLabel(p), head = h !== lastHalf ? `<div class="cl-lh">${h}</div>` : ""; lastHalf = h;
      return `${head}<button type="button" class="cl-li ${C.sel.editId === p.id ? "on" : ""} ${p.typeId ? "" : "todo"}" data-pid="${esc(p.id)}">
        <span class="cl-lt" style="background:${p.typeId ? typeColor(p.typeId) : "transparent"}"></span>
        <span class="mono">${p.balls}-${p.strikes}</span><span class="grow">${esc(p.batterName || "")}</span>
        <span>${esc(typeName(p) || "球種なし")}${p.speed ? " " + p.speed : ""}</span><span class="small">${RES_LABEL[p.result]}${p.paResult ? "・" + PA_LABEL[p.paResult] : ""}${p.bbPos ? "（" + posLabel(p.bbPos) + "）" : ""}</span></button>`;
    }).join("") + `<div class="row"><button class="btn small" id="clSync1" type="button" title="選んだ球と、今の動画の位置を合わせる" ${C.sel.editId && C.video.url ? "" : "disabled"}>この球の位置に合わせる</button></div>`;
    el.querySelectorAll("[data-pid]").forEach((b) => (b.onclick = () => selectPitch(b.dataset.pid)));
    syncMsg();
    $("clSync1").onclick = () => {
      const p = C.pitches.find((x) => x.id === C.sel.editId); if (!p || !C.videoEl) return;
      if (isNum(p.vt)) { toast("この球は動画の位置つきで入れた球です（合わせる必要はありません）"); return; }
      C.video.t0 = p.at - (C.videoEl.currentTime + 2.5) * 1000; // 入力は投げてから2.5秒くらい後が多い
      C.video.synced = true; pref.set(syncKey(), { t0: C.video.t0 }); syncMsg(); toast("時刻を合わせました");
    };
  }
  function selectPitch(id) {
    const p = C.pitches.find((x) => x.id === id); if (!p) return;
    C.sel = { typeId: p.typeId || null, zone: isNum(p.zx) ? { x: zxP(p), y: p.zy } : null, speed: p.speed ? String(p.speed) : "", editId: id };
    const t = pitchVideoTime(p);
    if (C.videoEl && C.video.url && isNum(t)) { C.videoEl.pause(); C.videoEl.currentTime = Math.max(0, t - (isNum(p.vt) ? 1.0 : 2.5 + 1.5)); }
    updateLiveParts(game(), liveOf(game()));
    $("clStatus").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function saveEdit() {
    const p = C.pitches.find((x) => x.id === C.sel.editId); if (!p) return;
    const t = C.sel.typeId ? typeById(C.sel.typeId) : null;
    const patch = { typeId: t ? t.id : "", typeName: t ? t.name : "", speed: C.sel.speed ? +C.sel.speed : null, zx: C.sel.zone ? C.sel.zone.x : null, zy: C.sel.zone ? C.sel.zone.y : null, zview: "P" };
    Object.assign(p, patch);
    FB.updatePitch(p.id, patch).catch((e) => { console.error(e); toast("保存できませんでした"); });
    // 次の、球種が入っていない球へ
    const i = C.pitches.indexOf(p), next = C.pitches.slice(i + 1).find((x) => !x.typeId) || C.pitches[i + 1];
    if (next) selectPitch(next.id); else { C.sel = { typeId: null, zone: null, speed: "", editId: null }; updateLiveParts(game(), liveOf(game())); toast("最後の球まで入れました"); }
  }

  // ===================== 球種の設定 =====================
  function renderTypes(r) {
    const list = clone(C.types);
    const draw = () => {
      $("tyList").innerHTML = list.map((t, i) => `<div class="ch-lrow"><span class="cl-lt" style="background:${PALETTE[i % PALETTE.length]}"></span>
        <input type="text" class="grow" data-tyn="${i}" maxlength="12" value="${esc(t.name)}" aria-label="球種の名前">
        <button class="btn small ghost" data-tyu="${i}" aria-label="上へ" ${i ? "" : "disabled"}>↑</button><button class="btn small ghost" data-tyd="${i}" aria-label="下へ" ${i < list.length - 1 ? "" : "disabled"}>↓</button>
        <label class="row small"><input type="checkbox" data-tyh="${i}" ${t.hidden ? "" : "checked"}> 使う</label></div>`).join("");
      $("tyList").querySelectorAll("[data-tyn]").forEach((x) => (x.oninput = () => { list[+x.dataset.tyn].name = x.value; }));
      $("tyList").querySelectorAll("[data-tyh]").forEach((x) => (x.onchange = () => { list[+x.dataset.tyh].hidden = !x.checked; }));
      $("tyList").querySelectorAll("[data-tyu]").forEach((x) => (x.onclick = () => { const i = +x.dataset.tyu; [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); }));
      $("tyList").querySelectorAll("[data-tyd]").forEach((x) => (x.onclick = () => { const i = +x.dataset.tyd; [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); }));
    };
    r.innerHTML = `<div class="card">
      <div class="row"><button class="btn small ghost" id="chBack" type="button">← 戻る</button><h2 class="grow">球種の設定</h2></div>
      <div id="tyList" class="stack" style="gap:6px"></div>
      <div class="row"><input type="text" id="tyNew" class="grow" maxlength="12" placeholder="追加する球種（例：ナックル）"><button class="btn small" id="tyAdd" type="button">追加</button></div>
      <button class="btn red" id="tySave" type="button">保存する</button></div>`;
    draw();
    $("chBack").onclick = () => go("home");
    $("tyAdd").onclick = () => { const n = $("tyNew").value.trim(); if (!n) return; list.push({ id: "t" + Date.now().toString(36), name: n, hidden: false }); $("tyNew").value = ""; draw(); };
    $("tySave").onclick = async () => {
      const clean = list.map((t) => ({ id: t.id, name: (t.name || "").trim() || "名前なし", hidden: !!t.hidden }));
      try { C.types = clean; await FB.setSetting("pitchTypes", { types: clean, updatedAt: new Date().toISOString() }); toast("球種を保存しました"); go("home"); }
      catch (e) { console.error(e); toast("保存できませんでした"); }
    };
  }

  // ===================== 集計 =====================
  const isStrike = (p) => ["CS", "SS", "F", "X"].includes(p.result);
  const isSwing = (p) => ["SS", "F", "X"].includes(p.result);
  const hasZone = (p) => isNum(p.zx) && isNum(p.zy);
  const inZone = (p) => hasZone(p) && Math.abs(p.zx) <= 1 && Math.abs(p.zy) <= 1;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);
  const keyP = (p) => p.pitcherId || "n:" + p.pitcherName;
  const keyB = (p) => p.batterId || "n:" + p.batterName;
  async function loadStatsPitches() {
    const ids = C.stats.game === "all" ? C.games.filter((g) => !C.stats.team || g.opponent === C.stats.team).map((g) => g.id) : [C.stats.game];
    const key = ids.join(",");
    if (C.statsKey === key && C.statsPitches) return C.statsPitches;
    // 開いている試合はリアルタイムのものを使う
    const out = [];
    for (const id of ids) {
      if (id === C.gameId && C.pitches.length) out.push(...C.pitches);
      else { C.cache = C.cache || {}; if (!C.cache[id]) C.cache[id] = await FB.getPitches(id); out.push(...C.cache[id]); }
    }
    C.statsKey = key; C.statsPitches = out;
    return out;
  }
  function paSummary(ps) {
    const pa = ps.filter((p) => p.paEnd), cnt = (r) => pa.filter((p) => p.paResult === r).length;
    const bb = cnt("BB"), hbp = cnt("HBP"), sac = cnt("SAC"), sf = cnt("SF"), k = cnt("K");
    const h = pa.filter((p) => HITS.includes(p.paResult)).length, ab = pa.length - bb - hbp - sac - sf;
    return { pa: pa.length, ab, h, k, bb, hbp, hr: cnt("HR"), avg: ab ? (h / ab).toFixed(3).replace(/^0/, "") : "—" };
  }
  async function renderStats(r, soft) {
    if (soft && C.stats.game !== C.gameId) return;
    if (soft) C.statsKey = null;
    const st = C.stats;
    r.innerHTML = `<div class="card"><p class="small muted">集計しています…</p></div>`;
    let all;
    try { all = await loadStatsPitches(); } catch (e) { console.error(e); r.innerHTML = `<div class="card"><p>読み込めませんでした。</p><button class="btn small" id="chBack">← 戻る</button></div>`; $("chBack").onclick = () => go("home"); return; }
    if (C.view !== "stats") return;
    const ps = all.filter((p) => (st.side === "opp" ? (st.tab === "p" ? p.pTeam === "opp" : p.bTeam === "opp") : (st.tab === "p" ? p.pTeam === "us" : p.bTeam === "us")));
    const gOpts = `<option value="all">全試合</option>` + C.games.map((g) => `<option value="${esc(g.id)}" ${st.game === g.id ? "selected" : ""}>${esc(g.date)} vs ${esc(g.opponent)}</option>`).join("");
    const tOpts = `<option value="">すべての相手</option>` + teams().map((t) => `<option value="${esc(t)}" ${st.team === t ? "selected" : ""}>${esc(t)}</option>`).join("");
    r.innerHTML = `
      <div class="card">
        <div class="row"><button class="btn small ghost" id="chBack" type="button">← 戻る</button><h2 class="grow">集計</h2><button class="btn small" id="stCsv" type="button">CSVで保存</button></div>
        <div class="grid2">
          <label class="field">試合<select id="stGame">${gOpts}</select></label>
          <label class="field">相手チーム（全試合のとき）<select id="stTeam" ${st.game === "all" ? "" : "disabled"}>${tOpts}</select></label>
        </div>
        <div class="row">
          <div class="seg" role="radiogroup" aria-label="チーム"><label><input type="radio" name="stSide" value="opp" ${st.side === "opp" ? "checked" : ""}><span>相手</span></label><label><input type="radio" name="stSide" value="us" ${st.side === "us" ? "checked" : ""}><span>自チーム</span></label></div>
          <div class="seg" role="radiogroup" aria-label="投手・打者"><label><input type="radio" name="stTab" value="p" ${st.tab === "p" ? "checked" : ""}><span>投手</span></label><label><input type="radio" name="stTab" value="b" ${st.tab === "b" ? "checked" : ""}><span>打者</span></label></div>
        </div>
      </div>
      <div class="card" id="stList"></div>
      <div id="stDetail" class="stack"></div>`;
    $("chBack").onclick = () => go("home");
    $("stGame").onchange = (e) => { st.game = e.target.value; st.who = null; renderStats(r); };
    $("stTeam").onchange = (e) => { st.team = e.target.value; st.who = null; renderStats(r); };
    r.querySelectorAll('input[name="stSide"]').forEach((x) => (x.onchange = () => { st.side = x.value; st.who = null; renderStats(r); }));
    r.querySelectorAll('input[name="stTab"]').forEach((x) => (x.onchange = () => { st.tab = x.value; st.who = null; renderStats(r); }));
    $("stCsv").onclick = () => exportCsv(all);
    if (st.tab === "p") renderPitcherTable(ps); else renderBatterTable(ps);
  }
  function groupBy(ps, kf) { const m = new Map(); for (const p of ps) { const k = kf(p); if (!m.has(k)) m.set(k, []); m.get(k).push(p); } return m; }
  function renderPitcherTable(ps) {
    const groups = [...groupBy(ps, keyP).entries()].sort((a, b) => b[1].length - a[1].length);
    $("stList").innerHTML = groups.length ? `<h2>投手</h2><div class="tablewrap"><table class="metrics st-table"><thead><tr><th>投手</th><th>球数</th><th>打者</th><th>三振</th><th>四死球</th><th>被安打</th><th>ストライク率</th><th>初球ストライク</th><th>空振り率</th></tr></thead><tbody>
      ${groups.map(([k, g]) => { const s = paSummary(g), f = g.filter((p) => p.balls === 0 && p.strikes === 0); const p0 = g[0];
        return `<tr data-who="${esc(k)}" class="${C.stats.who === k ? "on" : ""}"><td>${esc((p0.pitcherNo ? "#" + p0.pitcherNo + " " : "") + (p0.pitcherName || "不明"))}${p0.pThrows ? `<span class="small muted">（${HAND[p0.pThrows]}）</span>` : ""}</td><td>${g.length}</td><td>${s.pa}</td><td>${s.k}</td><td>${s.bb + s.hbp}</td><td>${s.h}</td><td>${pct(g.filter(isStrike).length, g.length)}</td><td>${pct(f.filter(isStrike).length, f.length)}</td><td>${pct(g.filter((p) => p.result === "SS").length, g.filter(isSwing).length)}</td></tr>`; }).join("")}
      </tbody></table></div>` : `<p class="small muted">まだ記録がありません。</p>`;
    $("stList").querySelectorAll("[data-who]").forEach((tr) => (tr.onclick = () => { C.stats.who = tr.dataset.who; renderPitcherTable(ps); }));
    const sel = groups.find(([k]) => k === C.stats.who);
    $("stDetail").innerHTML = ""; if (sel) renderPitcherDetail(sel[1]);
  }
  function typeRows(g) {
    const m = groupBy(g, (p) => p.typeId || "");
    return [...m.entries()].sort((a, b) => { const ia = C.types.findIndex((t) => t.id === a[0]), ib = C.types.findIndex((t) => t.id === b[0]); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
  }
  function renderPitcherDetail(g) {
    const p0 = g[0], rows = typeRows(g);
    const sit = [
      ["初球", (p) => p.balls === 0 && p.strikes === 0],
      ["打者有利", (p) => p.balls > p.strikes],
      ["投手有利", (p) => p.strikes > p.balls && !(p.balls === 0 && p.strikes === 0)],
      ["平行", (p) => p.balls === p.strikes && !(p.balls === 0 && p.strikes === 0)],
      ["2ストライク", (p) => p.strikes === 2],
    ];
    const typesUsed = rows.map(([id]) => id);
    const tname = (id) => (id ? (typeById(id) || {}).name || id : "球種なし");
    const sitRows = sit.map(([lab, f]) => { const s = g.filter(f); return `<tr><td>${lab}</td><td>${s.length}</td>${typesUsed.map((id) => `<td>${pct(s.filter((p) => (p.typeId || "") === id).length, s.length)}</td>`).join("")}</tr>`; }).join("");
    const vs = (h) => g.filter((p) => p.bBats === h);
    const box = $("stDetail");
    box.innerHTML = `
      <div class="card">
        <h2>${esc((p0.pitcherNo ? "#" + p0.pitcherNo + " " : "") + (p0.pitcherName || "不明"))} の配球</h2>
        <div class="tablewrap"><table class="metrics st-table"><thead><tr><th>球種</th><th>球数</th><th>割合</th><th>平均球速</th><th>最速</th><th>ストライク率</th><th>空振り率</th><th>右打者</th><th>左打者</th></tr></thead><tbody>
          ${rows.map(([id, t]) => { const sp = t.map((p) => p.speed).filter(isNum); return `<tr><td><span class="cl-lt" style="background:${id ? typeColor(id) : "transparent"}"></span>${esc(tname(id))}</td><td>${t.length}</td><td>${pct(t.length, g.length)}</td><td>${sp.length ? avg(sp).toFixed(0) : "—"}</td><td>${sp.length ? Math.max(...sp) : "—"}</td><td>${pct(t.filter(isStrike).length, t.length)}</td><td>${pct(t.filter((p) => p.result === "SS").length, t.filter(isSwing).length)}</td><td>${pct(t.filter((p) => p.bBats === "R").length, vs("R").length)}</td><td>${pct(t.filter((p) => p.bBats === "L").length, vs("L").length)}</td></tr>`; }).join("")}
        </tbody></table></div>
      </div>
      <div class="card">
        <h2>カウント別の配球</h2>
        <div class="tablewrap"><table class="metrics st-table"><thead><tr><th>カウント</th><th>球数</th>${typesUsed.map((id) => `<th>${esc(tname(id))}</th>`).join("")}</tr></thead><tbody>${sitRows}</tbody></table></div>
      </div>
      <div class="card">
        <h2>コース（投手目線）</h2>
        <div class="legend">${rows.filter(([id]) => id).map(([id]) => `<span><i style="background:${typeColor(id)}"></i>${esc(tname(id))}</span>`).join("")}</div>
        <div class="grid2" style="align-items:start"><div><div class="chart-title">右打者へ（${vs("R").filter(hasZone).length}球）</div><canvas class="st-zone" id="stZR"></canvas></div><div><div class="chart-title">左打者へ（${vs("L").filter(hasZone).length}球）</div><canvas class="st-zone" id="stZL"></canvas></div></div>
      </div>`;
    for (const [id, h] of [["stZR", "R"], ["stZL", "L"]]) {
      const cv = $(id), m = drawZoneBase(cv, h, "P"), ctx = cv.getContext("2d");
      vs(h).filter(hasZone).forEach((p) => drawDot(ctx, m, zxP(p), p.zy, p.typeId ? typeColor(p.typeId) : "#8d8d8d", "", 5));
    }
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderBatterTable(ps) {
    const groups = [...groupBy(ps, keyB).entries()].sort((a, b) => (a[1][0].slot ?? 9) - (b[1][0].slot ?? 9) || b[1].length - a[1].length);
    $("stList").innerHTML = groups.length ? `<h2>打者</h2><div class="tablewrap"><table class="metrics st-table"><thead><tr><th>打者</th><th>打席</th><th>打数</th><th>安打</th><th>打率</th><th>三振</th><th>四死球</th><th>スイング率</th><th>ボール球スイング</th><th>空振り率</th><th>初球スイング</th></tr></thead><tbody>
      ${groups.map(([k, g]) => { const s = paSummary(g), z = g.filter(hasZone), oz = z.filter((p) => !inZone(p)), f = g.filter((p) => p.balls === 0 && p.strikes === 0), b0 = g[0];
        return `<tr data-who="${esc(k)}" class="${C.stats.who === k ? "on" : ""}"><td>${esc((b0.batterNo ? "#" + b0.batterNo + " " : "") + (b0.batterName || "不明"))}${b0.bHand ? `<span class="small muted">（${HAND[b0.bHand]}）</span>` : ""}</td><td>${s.pa}</td><td>${s.ab}</td><td>${s.h}</td><td>${s.avg}</td><td>${s.k}</td><td>${s.bb + s.hbp}</td><td>${pct(g.filter(isSwing).length, g.length)}</td><td>${pct(oz.filter(isSwing).length, oz.length)}</td><td>${pct(g.filter((p) => p.result === "SS").length, g.filter(isSwing).length)}</td><td>${pct(f.filter(isSwing).length, f.length)}</td></tr>`; }).join("")}
      </tbody></table></div>` : `<p class="small muted">まだ記録がありません。</p>`;
    $("stList").querySelectorAll("[data-who]").forEach((tr) => (tr.onclick = () => { C.stats.who = tr.dataset.who; renderBatterTable(ps); }));
    const sel = groups.find(([k]) => k === C.stats.who);
    $("stDetail").innerHTML = ""; if (sel) renderBatterDetail(sel[1]);
  }
  function renderBatterDetail(g) {
    const b0 = g[0], rows = typeRows(g);
    const tname = (id) => (id ? (typeById(id) || {}).name || id : "球種なし");
    const pas = g.filter((p) => p.paEnd);
    const resColor = (p) => (p.result === "SS" ? "#e5484d" : p.result === "X" ? "#46a758" : p.result === "F" ? "#f5a524" : p.result === "CS" ? "#3e63dd" : "#8d8d8d");
    const box = $("stDetail");
    box.innerHTML = `
      <div class="card">
        <h2>${esc((b0.batterNo ? "#" + b0.batterNo + " " : "") + (b0.batterName || "不明"))}</h2>
        <div class="chips">${pas.map((p) => `<span class="chip ${HITS.includes(p.paResult) ? "turf" : ""}">${esc(halfLabel(p))} ${PA_LABEL[p.paResult] || ""}${p.bbType || p.bbPos ? "（" + [(BB_TYPES.find((x) => x[0] === p.bbType) || ["", ""])[1], posLabel(p.bbPos)].filter(Boolean).join("・") + "）" : ""}</span>`).join("")}</div>
        <div class="tablewrap"><table class="metrics st-table"><thead><tr><th>球種</th><th>見た球</th><th>スイング率</th><th>空振り率</th><th>打球</th></tr></thead><tbody>
          ${rows.map(([id, t]) => `<tr><td><span class="cl-lt" style="background:${id ? typeColor(id) : "transparent"}"></span>${esc(tname(id))}</td><td>${t.length}</td><td>${pct(t.filter(isSwing).length, t.length)}</td><td>${pct(t.filter((p) => p.result === "SS").length, t.filter(isSwing).length)}</td><td>${t.filter((p) => p.result === "X").length}</td></tr>`).join("")}
        </tbody></table></div>
      </div>
      <div class="card">
        <div class="stack">
          <div><div class="chart-title">打球方向</div><div class="legend"><span><i style="background:#46a758"></i>ヒット</span><span><i style="background:#8d8d8d"></i>アウトなど</span></div><canvas class="st-field" id="stF" style="max-width:420px"></canvas></div>
          <div><div class="chart-title">投げられたコース（投手目線）</div><div class="legend"><span><i style="background:#e5484d"></i>空振り</span><span><i style="background:#f5a524"></i>ファウル</span><span><i style="background:#46a758"></i>打球</span><span><i style="background:#3e63dd"></i>見逃し</span><span><i style="background:#8d8d8d"></i>ボール</span></div><canvas class="st-zone" id="stZB" style="max-width:340px"></canvas></div>
        </div>
      </div>`;
    drawField($("stF"), g.filter((p) => p.result === "X" && isNum(p.bbX)).map((p) => ({ x: p.bbX, y: p.bbY, color: HITS.includes(p.bbRes) ? "#46a758" : "#8d8d8d", r: 5 })));
    const cv = $("stZB"), m = drawZoneBase(cv, b0.bBats, "P"), ctx = cv.getContext("2d");
    g.filter(hasZone).forEach((p) => drawDot(ctx, m, zxP(p), p.zy, resColor(p), "", 5));
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function exportCsv(ps) {
    const cols = [
      ["日付", (p) => p.date], ["相手", (p) => p.opponent], ["球番号", (p) => p.seq], ["回", (p) => p.inning], ["表裏", (p) => (p.half === "T" ? "表" : "裏")],
      ["アウト", (p) => p.outs], ["ボール", (p) => p.balls], ["ストライク", (p) => p.strikes],
      ["投手チーム", (p) => (p.pTeam === "us" ? "自" : "相手")], ["投手背番号", (p) => p.pitcherNo], ["投手", (p) => p.pitcherName], ["投", (p) => HAND[p.pThrows] || ""],
      ["打順", (p) => (isNum(p.slot) ? p.slot + 1 : "")], ["打者背番号", (p) => p.batterNo], ["打者", (p) => p.batterName], ["打", (p) => HAND[p.bHand] || ""],
      ["球種", (p) => typeName(p)], ["球速", (p) => (isNum(p.speed) ? p.speed : "")], ["コース横（投手目線・右が＋）", (p) => (isNum(p.zx) ? zxP(p) : "")], ["コース高さ", (p) => (isNum(p.zy) ? p.zy : "")],
      ["ゾーン", (p) => (hasZone(p) ? (inZone(p) ? "内" : "外") : "")], ["結果", (p) => RES_LABEL[p.result]],
      ["打球の種類", (p) => (BB_TYPES.find((x) => x[0] === p.bbType) || ["", ""])[1]], ["打球方向", (p) => posLabel(p.bbPos)], ["打球方向X", (p) => (isNum(p.bbX) ? p.bbX : "")], ["打球方向Y", (p) => (isNum(p.bbY) ? p.bbY : "")],
      ["打席結果", (p) => PA_LABEL[p.paResult] || ""],
    ];
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const sorted = ps.slice().sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.gameId || "").localeCompare(b.gameId || "") || a.seq - b.seq);
    const csv = "﻿" + [cols.map((c) => c[0]).join(","), ...sorted.map((p) => cols.map((c) => q(c[1](p))).join(","))].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const g = C.games.find((x) => x.id === C.stats.game);
    const name = g ? `chart_${g.date}_${g.opponent}.csv` : `chart_all.csv`;
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name.replace(/[\\/:*?"<>|\s]/g, "_");
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ---------- 外から呼ぶもの ----------
  window.Chart = {
    start,
    onShow(name) { if (name === "chart") render(); else document.body.classList.remove("chart-live"); },
    _state: C, _advance: advance,
  };
  window.addEventListener("resize", () => { if (!$("tab-chart") || $("tab-chart").hidden) return; if (C.view === "live") drawZoneInput(); });
})();
