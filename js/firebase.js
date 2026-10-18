// Firebase（チーム共有の記録）との接続。仮バージョン：ログイン画面なし（開いたスマホごとに自動で匿名ログイン）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, addDoc, setDoc, getDoc, deleteDoc, collection, onSnapshot, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const cfg = window.FIREBASE_CONFIG || {};
if (!cfg.apiKey || String(cfg.apiKey).startsWith("ここに")) {
  window.FB = null;
  window.dispatchEvent(new Event("fb-missing"));
} else {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  const db = getFirestore(app);
  // 骨格データは入れ子の配列なので、Firestoreに入れるときは文字列にする
  const toStore = (d) => { const o = { ...d }; if (o.skel) { o.skelJson = JSON.stringify(o.skel); delete o.skel; } return o; };
  const fromStore = (id, d) => { const o = { id, ...d }; if (o.skelJson) { try { o.skel = JSON.parse(o.skelJson); } catch (e) { o.skel = null; } delete o.skelJson; } delete o.serverTime; return o; };

  window.FB = {
    // 自動でログインして、ログインできたら cb(uid) を呼ぶ
    start(cb, onError) {
      onAuthStateChanged(auth, (u) => { if (u) cb(u.uid); });
      signInAnonymously(auth).catch(onError);
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
    async addPlayer(name) { const r = await addDoc(collection(db, "players"), { name, createdAt: new Date().toISOString() }); return r.id; },
    async deletePlayer(id) { await deleteDoc(doc(db, "players", id)); },
  };
  window.dispatchEvent(new Event("fb-ready"));
}
