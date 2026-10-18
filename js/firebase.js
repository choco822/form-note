// Firebase（チーム共有の記録）との接続。仮バージョン：ログイン画面なし（開いたスマホごとに自動で匿名ログイン）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, addDoc, deleteDoc, collection, onSnapshot, serverTimestamp,
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
    async addRecord(data) { await addDoc(collection(db, "records"), { ...toStore(data), serverTime: serverTimestamp() }); },
    async deleteRecord(id) { await deleteDoc(doc(db, "records", id)); },
    async addPlayer(name) { const r = await addDoc(collection(db, "players"), { name, createdAt: new Date().toISOString() }); return r.id; },
    async deletePlayer(id) { await deleteDoc(doc(db, "players", id)); },
  };
  window.dispatchEvent(new Event("fb-ready"));
}
