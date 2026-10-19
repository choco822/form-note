// Firebase（チーム共有の記録）との接続。仮バージョン：ログイン画面なし（開いたスマホごとに自動で匿名ログイン）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc, collection, onSnapshot, serverTimestamp, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const cfg = window.FIREBASE_CONFIG || {};
if (!cfg.apiKey || String(cfg.apiKey).startsWith("ここに")) {
  window.FB = null;
  window.dispatchEvent(new Event("fb-missing"));
} else {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  // 球場で電波が悪くても入力が消えないように、スマホの中にも保存しておく（電波が戻ると自動で送る）
  let db;
  try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { console.warn("オフライン保存は使えません", e); db = getFirestore(app); }
  // 骨格データは入れ子の配列なので、Firestoreに入れるときは文字列にする
  const toStore = (d) => { const o = { ...d }; if (o.skel) { o.skelJson = JSON.stringify(o.skel); delete o.skel; } return o; };
  const fromStore = (id, d) => { const o = { id, ...d }; if (o.skelJson) { try { o.skel = JSON.parse(o.skelJson); } catch (e) { o.skel = null; } delete o.skelJson; } delete o.serverTime; return o; };

  // 書き込み：電波がないときも、スマホの中には先に保存される。送信の完了は最大1.5秒だけ待ち、
  // それ以上かかるときは待たずに進める（送信は裏で続き、電波が戻ると自動で送られる）
  const w = (p) => { p.catch((e) => console.error("書き込みエラー", e)); return Promise.race([p, new Promise((r) => setTimeout(r, 1500))]); };
  const newId = (col) => doc(collection(db, col)).id;
  window.FB = {
    // 自動でログインして、ログインできたら cb(uid) を呼ぶ
    // 一度ログインしたスマホは、電波がなくてもそのまま使える
    start(cb, onError) {
      let started = false, tried = false;
      onAuthStateChanged(auth, (u) => {
        if (u) { if (!started) { started = true; cb(u.uid); } return; }
        if (!tried) { tried = true; signInAnonymously(auth).catch(onError); }
      });
    },
    watchRecords(cb, onError) {
      return onSnapshot(collection(db, "records"), (s) => cb(s.docs.map((d) => fromStore(d.id, d.data()))), onError);
    },
    watchPlayers(cb, onError) {
      return onSnapshot(collection(db, "players"), (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data() }))), onError);
    },
    // 記録のIDを先に決める（動画を先に保存して、記録と結びつけるため）
    newRecordId() { return doc(collection(db, "records")).id; },
    async addRecord(data, id) {
      const body = { ...toStore(data), serverTime: serverTimestamp() };
      if (id) await setDoc(doc(db, "records", id), body); else await addDoc(collection(db, "records"), body);
    },
    // 記録を消すときは、結びついた動画もいっしょに消す（その分の容量が空く）
    async deleteRecord(id, clipN = 0) {
      for (let i = 0; i < clipN; i++) { try { await deleteDoc(doc(db, "clips", `${id}_${i}`)); } catch (e) { console.warn(e); } }
      await deleteDoc(doc(db, "records", id));
    },
    // 短い動画：文字にして（base64）、1件1MBの制限に収まるように分けて保存する
    async addClip(rid, mime, b64) {
      const CH = 700000, n = Math.ceil(b64.length / CH);
      for (let i = 0; i < n; i++) await setDoc(doc(db, "clips", `${rid}_${i}`), { rid, i, n, mime, data: b64.slice(i * CH, (i + 1) * CH), createdAt: new Date().toISOString() });
      return n;
    },
    async getClip(rid, n) {
      let data = "", mime = "";
      for (let i = 0; i < n; i++) { const s = await getDoc(doc(db, "clips", `${rid}_${i}`)); if (!s.exists()) return null; data += s.data().data; mime = s.data().mime; }
      return { mime, data };
    },
    async deleteClips(rid, n) { for (let i = 0; i < n; i++) { try { await deleteDoc(doc(db, "clips", `${rid}_${i}`)); } catch (e) { console.warn(e); } } },
    // extra：{ team（相手チーム名。自チームは空）, number（背番号）, throws（投 R/L）, bats（打 R/L/S） }
    async addPlayer(name, extra = {}) {
      const d = { name, createdAt: new Date().toISOString() };
      for (const k of ["team", "number", "throws", "bats"]) if (extra[k]) d[k] = String(extra[k]);
      const id = newId("players"); await w(setDoc(doc(db, "players", id), d)); return id;
    },
    async updatePlayer(id, patch) { await w(updateDoc(doc(db, "players", id), patch)); },
    async deletePlayer(id) { await w(deleteDoc(doc(db, "players", id))); },

    // ===== 一球チャート =====
    watchGames(cb, onError) { return onSnapshot(collection(db, "games"), (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), onError); },
    async addGame(data) { const id = newId("games"); await w(setDoc(doc(db, "games", id), data)); return id; },
    async updateGame(id, patch) { await w(updateDoc(doc(db, "games", id), patch)); },
    async deleteGame(id) {
      const s = await getDocs(query(collection(db, "pitches"), where("gameId", "==", id)));
      for (const d of s.docs) w(deleteDoc(d.ref));
      await w(deleteDoc(doc(db, "games", id)));
    },
    // 電波が悪くて、まだ送れていない球の数も返す
    watchPitches(gameId, cb, onError) {
      return onSnapshot(query(collection(db, "pitches"), where("gameId", "==", gameId)), { includeMetadataChanges: true },
        (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() })), s.docs.filter((d) => d.metadata.hasPendingWrites).length), onError);
    },
    async getPitches(gameId) { const s = await getDocs(query(collection(db, "pitches"), where("gameId", "==", gameId))); return s.docs.map((d) => ({ id: d.id, ...d.data() })); },
    async addPitch(id, data) { await w(setDoc(doc(db, "pitches", id), data)); },
    async updatePitch(id, patch) { await w(updateDoc(doc(db, "pitches", id), patch)); },
    async deletePitch(id) { await w(deleteDoc(doc(db, "pitches", id))); },
    watchSetting(key, cb, onError) { return onSnapshot(doc(db, "settings", key), (s) => cb(s.exists() ? s.data() : null), onError); },
    async setSetting(key, data) { await w(setDoc(doc(db, "settings", key), data)); },
  };
  window.dispatchEvent(new Event("fb-ready"));
}
