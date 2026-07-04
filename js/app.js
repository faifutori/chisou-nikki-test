"use strict";
/* =========================================================
   ▼▼ 調整用設定（テスト時はここだけ書き換える）▼▼

   LAYER_INTERVAL … 地層が固まる周期
     "day"    : 24時間ごと（本番用・デフォルト）
     "hour"   : 1時間ごと（テスト用）
     "minute" : 1分ごと（テスト用・すぐ層ができる）

   例: 1分で試すなら → const LAYER_INTERVAL = "minute";
   テストで出来た data/ 内のフォルダ（例 2026-07-03_14-05）は
   不要になったら手で削除してかまいません。
   ========================================================= */
const LAYER_INTERVAL = "minute";
/* ========================================================= */

/* =========================================================
   地層日記 — 記録用フロントエンド
   - fBm(value noise) による地層テクスチャ生成
   - ひとことの落下・堆積アニメーション（文字は感情の色）
   - 地層はワールド座標で実寸のまま積み上がり、
     地表が画面の半分に達すると視点が自動で上へスクロール。
     ホイール / ドラッグで過去の深い層まで掘って見られる。
   - 保存はサーバ経由で data/YYYY-MM-DD/day.json へ
   ========================================================= */

/* ---------- 感情定義（Plutchik の感情環 + 低彩度=低覚醒） ---------- */
const EMOTIONS = [
  { id:"joy",          label:"喜び",   color:"#D9B23B" },
  { id:"trust",        label:"信頼",   color:"#7FA65A" },
  { id:"fear",         label:"恐れ",   color:"#3F6B52" },
  { id:"surprise",     label:"驚き",   color:"#5AA8A0" },
  { id:"sadness",      label:"悲しみ", color:"#4E6E9E" },
  { id:"disgust",      label:"嫌悪",   color:"#8A6A9C" },
  { id:"anger",        label:"怒り",   color:"#B5473C" },
  { id:"anticipation", label:"期待",   color:"#C97C3F" },
  { id:"calm",         label:"平穏",   color:"#B4A98F" },
];
const EMO = Object.fromEntries(EMOTIONS.map(e => [e.id, e]));

/* ---------- 乱数・ノイズ（決定論的：seed が同じなら同じ地層） ---------- */
function hash2(x, y, seed){
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 974634213);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, seed){
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed),     b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, seed, oct){
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for(let i = 0; i < oct; i++){
    s += valueNoise(x * f, y * f, seed + i * 131) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return s / norm; // 0..1
}

/* ---------- 色ユーティリティ ---------- */
function hexToRgb(hex){
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb){
  return "#" + rgb.map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
}
function mix(c1, c2, t){
  return [0,1,2].map(i => Math.round(c1[i] + (c2[i] - c1[i]) * t));
}
const EARTH = hexToRgb("#5C4E3B");   // 堆積後に混ざる「土の色」
const WHITE = [255, 255, 255];
// 文字の色 = 感情色を少し明るくしたもの（暗い背景でも読めるように）
function textColorOf(rgb){
  const c = mix(rgb, WHITE, 0.30);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ---------- 状態 ---------- */
function todayStr(){   // 現在の「周期キー」を返す（= フォルダ名になる）
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if(LAYER_INTERVAL === "hour"){ return `${base}_${p(d.getHours())}`; }
  if(LAYER_INTERVAL === "minute"){ return `${base}_${p(d.getHours())}-${p(d.getMinutes())}`; }
  return base;   // "day": YYYY-MM-DD（本番）
}
const state = {
  seed: 1,
  days: [],                                  // 過去の day.json（= 層）過去→現在
  today: { date: todayStr(), entries: [] },  // 今日の分（まだ層になっていない）
};
let previewDeposit = false;                  // 今日の分を層として試し見するモード

/* サーバが無い環境（GitHub Pages 等での公開版）では、
   自動的にブラウザ内保存（localStorage）へ切り替わる。
   手元で node server.js を動かしている場合は従来どおり data/ フォルダに保存。 */
let STATIC_MODE = false;
const LOCAL_KEY = "chisou-nikki-v1";
function loadLocalStore(){
  try{
    const raw = localStorage.getItem(LOCAL_KEY);
    if(raw){ return JSON.parse(raw); }
  }catch(e){ /* 破損時は初期化 */ }
  const fresh = { seed: (Math.random() * 1e9) | 0, days: [] };
  try{ localStorage.setItem(LOCAL_KEY, JSON.stringify(fresh)); }catch(e){}
  return fresh;
}
function applyState(j){
  state.seed = j.seed;
  const t = todayStr();
  state.days = j.days.filter(d => d.date < t);
  const todayData = j.days.find(d => d.date === t);
  state.today = { date: t, entries: todayData ? todayData.entries : [] };
}
async function fetchState(){
  try{
    const res = await fetch("/api/state");
    if(!res.ok){ throw new Error(); }
    applyState(await res.json());
    STATIC_MODE = false;
  }catch(e){
    STATIC_MODE = true;
    applyState(loadLocalStore());
  }
}

/* ---------- 保存: 動画生成プログラムが読む day.json を組み立てる ---------- */
function buildDayJson(){
  const entries = state.today.entries;
  const chars = entries.reduce((s, e) => s + e.text.length, 0);
  return {
    version: 1,
    date: state.today.date,
    message_count: entries.length,
    total_chars: chars,
    layer: {
      color_rgb: averageColorRgb(entries),
      color_hex: rgbToHex(averageColorRgb(entries)),
      thickness: Math.max(12, Math.min(90, 12 + chars * 0.6)),
    },
    entries,
  };
}
async function saveToday(){
  const day = buildDayJson();
  writeDayFile(day);                       // フォルダ保存が有効なら実ファイルにも書く
  if(STATIC_MODE){
    try{
      const j = loadLocalStore();
      const i = j.days.findIndex(d => d.date === day.date);
      if(i >= 0){ j.days[i] = day; } else { j.days.push(day); }
      localStorage.setItem(LOCAL_KEY, JSON.stringify(j));
    }catch(e){ setStatus("ブラウザへの保存に失敗しました。"); }
    return;
  }
  try{
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(day),
    });
    if(!res.ok){ throw new Error(); }
  }catch(e){
    setStatus("保存に失敗しました。サーバ（node server.js）が起動しているか確認してください。");
  }
}
function averageColorRgb(entries){
  if(!entries.length){ return [92, 78, 59]; }
  let r = 0, g = 0, b = 0, w = 0;
  for(const e of entries){
    const wi = Math.max(1, e.text.length);
    r += e.color_rgb[0] * wi; g += e.color_rgb[1] * wi; b += e.color_rgb[2] * wi; w += wi;
  }
  return [r / w, g / w, b / w].map(Math.round);
}

/* ---------- 実フォルダへの保存・書き出し・読み込み ----------
   公開版（GitHub Pages 等）でも、ユーザーが選んだ実フォルダに
   data/ と同じ構造（日付フォルダ + day.json）を自動保存できる。
   選んだフォルダの記憶は IndexedDB に保持し、次回はワンクリックで再開。
--------------------------------------------------------------- */
let dirHandle = null;
function idb(){
  return new Promise((ok, ng) => {
    const r = indexedDB.open("chisou-nikki", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error);
  });
}
async function idbSet(k, v){
  const db = await idb();
  return new Promise((ok, ng) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(v, k);
    tx.oncomplete = () => ok(); tx.onerror = () => ng(tx.error);
  });
}
async function idbGet(k){
  const db = await idb();
  return new Promise((ok, ng) => {
    const rq = db.transaction("handles", "readonly").objectStore("handles").get(k);
    rq.onsuccess = () => ok(rq.result); rq.onerror = () => ng(rq.error);
  });
}
async function writeConfigFile(){
  if(!dirHandle){ return; }
  const fh = await dirHandle.getFileHandle("config.json", { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify({ version: 1, seed: state.seed }, null, 2));
  await w.close();
}
async function writeDayFile(day){
  if(!dirHandle || !day.entries.length){ return; }
  try{
    const dh = await dirHandle.getDirectoryHandle(day.date, { create: true });
    const fh = await dh.getFileHandle("day.json", { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(day, null, 2));
    await w.close();
  }catch(e){
    dirHandle = null; const bd = $("btnDir"); if(bd){ bd.classList.remove("on"); }
    setStatus("フォルダへの保存に失敗しました。もう一度「フォルダ保存」を押してください。");
  }
}
async function onFolderButton(){
  try{
    // 前回のフォルダが記憶されていれば、許可の再取得だけで再開
    if(!dirHandle){
      const h = await idbGet("dir").catch(() => null);
      if(h && await h.requestPermission({ mode: "readwrite" }) === "granted"){
        dirHandle = h; $("btnDir").classList.add("on");
        await writeConfigFile(); await writeDayFile(buildDayJson());
        setStatus("フォルダ保存を再開しました。");
        return;
      }
    }
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    await idbSet("dir", dirHandle);
    $("btnDir").classList.add("on");
    await writeConfigFile(); await writeDayFile(buildDayJson());
    setStatus("フォルダ保存を有効にしました。以後、積むたびに自動保存されます。");
  }catch(e){ /* 選択キャンセル */ }
}
async function restoreFolder(){
  if(!("showDirectoryPicker" in window)){ return; }
  const b = $("btnDir"); if(!b){ return; } b.hidden = false;
  try{
    const h = await idbGet("dir");
    if(h && await h.queryPermission({ mode: "readwrite" }) === "granted"){
      dirHandle = h; $("btnDir").classList.add("on");
    }
  }catch(e){}
}
function exportData(){
  const j = STATIC_MODE
    ? loadLocalStore()
    : { seed: state.seed,
        days: [...state.days, ...(state.today.entries.length ? [buildDayJson()] : [])] };
  const blob = new Blob([JSON.stringify(j, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `chisou-nikki-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus("ダウンロードフォルダに書き出しました。");
}
async function importData(file){
  try{
    const j = JSON.parse(await file.text());
    if(!j || !Array.isArray(j.days)){ throw new Error(); }
    if(STATIC_MODE){
      localStorage.setItem(LOCAL_KEY, JSON.stringify(j));
      applyState(j);
    }else{
      for(const d of j.days){
        await fetch("/api/save", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) });
      }
      await fetchState();
    }
    restoreToday(); buildStrata(); updateMeta();
    setStatus("読み込みました。");
  }catch(e){ setStatus("読み込めませんでした。書き出したJSONファイルを選んでください。"); }
}

/* ---------- キャンバスと視点（カメラ） ----------
   地層は「ワールド座標」で実寸のまま描く（圧縮しない）。
   worldY: 地層オフスクリーン内のローカル y（0 = 世界の最上部）
   screenY = viewY + worldY  （viewY = 地層画像を画面に置く位置）

   viewY の決め方:
   - 地層が浅いうち  … 画面の底に地層の底を合わせる
   - 地表が画面の半分に達したら … 地表を画面の半分に固定
     （= 積むほど視点が自動で上にスクロールしていく）
   - ホイール / ドラッグで scrollDepth を増やすと深部を見に行ける
--------------------------------------------------- */
const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;
let strataCanvas = null;
let SH = 1;                    // 地層ワールドの高さ(px)
let surfaceLine = [];          // x ごとの地表 worldY
let surfMin = 1;               // 地表の最高点（worldY の最小値）
let scrollDepth = 0;           // ユーザーが掘った深さ
let viewY = null;              // 現在の視点（滑らかに追従）
let groundY = 0;               // 文字の着地基準線（入力パネルの少し上）
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function resize(){
  DPR = Math.min(devicePixelRatio || 1, 2);
  W = innerWidth; H = innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  const pr = document.getElementById("panel").getBoundingClientRect();
  groundY = Math.max(H * 0.35, pr.top - 14);   // 着地基準線 = パネル上端の少し上
  buildStrata();
  layoutRested();
}

function baseViewY(){
  // 地表（文字の着地基準線）を常に入力パネルの少し上に固定する。
  // 層が増えるほど古い層は画面の下へ沈み、掘って見に行ける。
  return groundY - surfMin;
}
function maxScrollDepth(){
  return Math.max(0, baseViewY() + SH - H);   // 画面より下にはみ出た深さぶんだけ掘れる
}
function targetViewY(){
  scrollDepth = Math.max(0, Math.min(maxScrollDepth(), scrollDepth));
  return baseViewY() - scrollDepth;
}

/* ---------- 地層テクスチャ生成 ----------
   1. 各層の上面を 1D ノイズで波打たせる（層理面のうねり）
   2. 層内は fBm でまだら模様（堆積物の不均質さ）
   3. sin + ドメインワープで細かい葉理（ラミナ）を刻む
   4. ピクセル単位の乱数で粒状感（グレイン）
   5. 古い層ほど暗く（続成・圧密のメタファ）
---------------------------------------------------------- */
function currentLayers(){
  const layers = state.days.map(d => ({ color: d.layer.color_hex, thickness: d.layer.thickness }));
  if(previewDeposit && state.today.entries.length){
    const j = buildDayJson();
    layers.push({ color: j.layer.color_hex, thickness: j.layer.thickness });
  }
  // 一番下に「何もないただの土」の基盤を敷く。
  // 基準線から画面の底まで届く厚さを確保し、感情の層が増えるほど土は下へ沈む。
  const totalReal = layers.reduce((s, l) => s + l.thickness, 0);
  const soil = Math.max(48, (H - groundY) + 24 - totalReal);
  layers.unshift({ color: "#4A3D2C", thickness: soil });
  return layers;
}
function buildStrata(){
  const layers = currentLayers();
  const total = layers.reduce((s, l) => s + l.thickness, 0);
  SH = Math.max(1, Math.ceil(total + 16));            // うねり分の余白を上に確保
  strataCanvas = document.createElement("canvas");
  strataCanvas.width = Math.max(1, W); strataCanvas.height = SH;
  surfaceLine = new Float32Array(Math.max(1, W)).fill(SH);
  surfMin = SH;
  if(!layers.length || W === 0){ return; }

  const seed = state.seed;
  const tops = [];
  let bottom = new Float32Array(W).fill(SH);
  for(let i = 0; i < layers.length; i++){
    const t = Math.max(3, layers[i].thickness);
    const amp = Math.min(7, t * 0.35);
    const top = new Float32Array(W);
    for(let x = 0; x < W; x++){
      const wob = (fbm(x * 0.008, i * 37.7, seed + i * 17, 3) * 2 - 1) * amp;
      top[x] = Math.min(bottom[x] - 2, bottom[x] - t + wob);
    }
    tops.push(top);
    bottom = top;
  }
  let mn = SH;
  for(let x = 0; x < W; x++){
    surfaceLine[x] = tops[tops.length - 1][x];
    if(surfaceLine[x] < mn){ mn = surfaceLine[x]; }
  }
  surfMin = mn;

  const sctx = strataCanvas.getContext("2d");
  const yMin = Math.max(0, Math.floor(surfMin) - 2);
  if(SH - yMin <= 0){ return; }
  const img = sctx.createImageData(W, SH - yMin);
  const data = img.data;
  const cols = layers.map(l => mix(hexToRgb(l.color), EARTH, 0.30));

  for(let x = 0; x < W; x++){
    for(let y = yMin; y < SH; y++){
      if(y < tops[layers.length - 1][x]){ continue; }
      let cur = layers.length - 1;
      while(cur > 0 && y >= tops[cur - 1][x]){ cur--; }
      const base = cols[cur];
      const ls = seed + cur * 977;

      const patch = fbm(x * 0.012, y * 0.045, ls, 4);
      const warp  = fbm(x * 0.006, y * 0.006, ls + 5, 3) * 8;
      const lam   = Math.sin(y * 0.85 + warp) * 0.05;
      const grain = (hash2(x, y, ls + 9) - 0.5) * 0.13;
      const edge  = (y - tops[cur][x] < 1.6) ? 0.72 : 1;
      const olded = 1 - (layers.length - 1 - cur) * 0.018;

      const shade = (0.80 + (patch - 0.5) * 0.34 + lam + grain) * edge * Math.max(0.7, olded);
      const p = ((y - yMin) * W + x) * 4;
      data[p]     = Math.max(0, Math.min(255, base[0] * shade));
      data[p + 1] = Math.max(0, Math.min(255, base[1] * shade));
      data[p + 2] = Math.max(0, Math.min(255, base[2] * shade));
      data[p + 3] = 255;
    }
  }
  sctx.putImageData(img, 0, yMin);
}
function surfaceYAt(x){       // worldY を返す
  const xi = Math.max(0, Math.min(W - 1, Math.round(x)));
  return surfaceLine.length ? surfaceLine[xi] : SH;
}

/* ---------- ひとことの堆積（今日の分 / worldY で保持） ---------- */
const rested = [];
const falling = [];
const BUCKET = 90;
let pile = {};

function layoutRested(){
  pile = {};
  for(const e of rested){
    e.x = e.x_norm * W;
    const b = Math.floor(e.x / BUCKET);
    const ph = pile[b] || 0;
    e.y = surfaceYAt(e.x) - 12 - ph;   // worldY
    pile[b] = ph + e.size * 1.15;
  }
}
function restoreToday(){
  rested.length = 0; falling.length = 0;
  for(const it of state.today.entries){
    rested.push({ text: it.text, font: it.font, weight: it.weight || 700,
      color: textColorOf(it.color_rgb),
      x_norm: it.x_norm, x: 0, y: 0, rot: it.rot, size: it.size });
  }
  layoutRested();
}

function spawnEntry(text, font, emotionId, sizePx){
  const size = Math.max(12, Math.min(120, sizePx || 30));   // 文字の大きさ（ユーザー指定）
  const x_norm = 0.08 + Math.random() * 0.84;
  const rot = (Math.random() - 0.5) * 0.09;
  const emo = EMO[emotionId];
  const rgb = hexToRgb(emo.color);
  state.today.entries.push({
    ts: new Date().toISOString(),
    text,
    font,
    weight: 700,          // 太めのゴシックを基準にする
    emotion: emo.id,
    emotion_label: emo.label,
    color_rgb: rgb,
    x_norm,
    rot,
    size,
  });
  saveToday();
  scrollDepth = 0;                                   // 掘っていたら地表に戻って見届ける
  const startY = -40 - (viewY === null ? 0 : viewY); // 画面上端の少し上（worldY）
  const item = { text, font, weight: 700, color: textColorOf(rgb),
    x_norm, x: x_norm * W, rot, size, y: startY, vy: 0 };
  if(reduceMotion){ rested.push(item); layoutRested(); }
  else{ falling.push(item); }
  updateMeta();
}

/* ---------- 描画ループ ---------- */
function frame(){
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // 視点を目標へ滑らかに追従（積み上がると自動で上へスクロール）
  const tv = targetViewY();
  if(viewY === null){ viewY = tv; }
  viewY += (tv - viewY) * (reduceMotion ? 1 : 0.16);

  if(strataCanvas){ ctx.drawImage(strataCanvas, 0, viewY); }

  // 落下更新（worldY）
  for(let i = falling.length - 1; i >= 0; i--){
    const f = falling[i];
    f.vy += 0.55; f.y += f.vy;
    const b = Math.floor(f.x / BUCKET);
    const target = surfaceYAt(f.x) - 12 - (pile[b] || 0);
    if(f.y >= target){
      f.y = target;
      pile[b] = (pile[b] || 0) + f.size * 1.15;
      rested.push(f); falling.splice(i, 1);
    }
  }
  if(!previewDeposit){
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const drawText = (e) => {
      ctx.save();
      ctx.translate(e.x, viewY + e.y); ctx.rotate(e.rot);
      ctx.font = `${e.weight || 700} ${e.size}px "${e.font}", sans-serif`;   // 太めが基準
      ctx.fillStyle = e.color;                       // 感情の色
      ctx.fillText(e.text, 0, 0);
      ctx.restore();
    };
    rested.forEach(drawText);
    falling.forEach(drawText);
  }
  requestAnimationFrame(frame);
}

/* ---------- スクロール操作（ホイール / ドラッグ） ---------- */
addEventListener("wheel", (e) => {
  if(e.target.closest && e.target.closest("#panel")){ return; }  // 入力パネル上は無視
  scrollDepth += e.deltaY * 0.8;   // 下に回すと深く掘る
}, { passive: true });

let dragging = false, lastPY = 0;
canvas.addEventListener("pointerdown", (e) => { dragging = true; lastPY = e.clientY; });
addEventListener("pointermove", (e) => {
  if(!dragging){ return; }
  scrollDepth += (e.clientY - lastPY);   // 上へドラッグ = 深く掘る
  lastPY = e.clientY;
});
addEventListener("pointerup", () => { dragging = false; });

/* ---------- 日付ロールオーバー ----------
   0時のタイマーではなくスリープ復帰にも強い「日付比較」方式。
   昨日の day.json はすでにディスク上にあるため、
   再取得するだけで昨日は自動的に「層」側へ移る。
------------------------------------------- */
async function checkRollover(){
  if(state.today.date !== todayStr()){
    try{
      await fetchState();
      restoreToday();
      buildStrata();
      updateMeta();
      setStatus("周期が切り替わりました。前の分がひとつの層になっています。");
    }catch(e){ /* 次の周期で再試行 */ }
  }
}

/* ---------- UI ---------- */
const $ = id => document.getElementById(id);
let selectedEmotion = null;

function buildEmotionButtons(){
  const wrap = $("emotions");
  for(const e of EMOTIONS){
    const btn = document.createElement("button");
    btn.className = "emo"; btn.type = "button";
    // 見本はパステル調に淡く表示（保存・描画に使う色は元のまま）
    const pastel = rgbToHex(mix(hexToRgb(e.color), WHITE, 0.45));
    btn.innerHTML = `<span class="sw" style="background:${pastel}"></span><span class="lb">${e.label}</span>`;
    btn.addEventListener("click", () => {
      selectedEmotion = e.id;
      wrap.querySelectorAll(".emo").forEach(b => b.classList.remove("sel"));
      btn.classList.add("sel");
    });
    wrap.appendChild(btn);
  }
}

/* ---------- フォント ----------
   - 一覧には「この端末に実在し、日本語グリフを持つ」フォントだけを出す
   - 判定: 日本語文字列の描画幅が、総称フォント（monospace / serif）への
     フォールバック時の幅と異なれば「自前の日本語グリフを持つ」とみなす
   - 既定は太めのゴシック体
--------------------------------- */
const measCtx = document.createElement("canvas").getContext("2d");
const JP_SAMPLE = "日本語のあ漢字永遠";
const LATIN_SAMPLE = "AaBbWwMmIiLl0123";
function textW(sample, fontList){
  measCtx.font = `40px ${fontList}`;
  return measCtx.measureText(sample).width;
}
const BASE_W = {
  jpMono: textW(JP_SAMPLE, "monospace"), jpSerif: textW(JP_SAMPLE, "serif"),
  laMono: textW(LATIN_SAMPLE, "monospace"), laSerif: textW(LATIN_SAMPLE, "serif"),
};
function fontExists(family){
  return textW(LATIN_SAMPLE, `"${family}", monospace`) !== BASE_W.laMono
      || textW(LATIN_SAMPLE, `"${family}", serif`) !== BASE_W.laSerif;
}
function supportsJapanese(family){
  return textW(JP_SAMPLE, `"${family}", monospace`) !== BASE_W.jpMono
      || textW(JP_SAMPLE, `"${family}", serif`) !== BASE_W.jpSerif;
}
const FALLBACK_FONTS = [
  "Hiragino Kaku Gothic ProN","Hiragino Sans","Hiragino Maru Gothic ProN","Hiragino Mincho ProN",
  "Yu Gothic","Yu Mincho","Meiryo","BIZ UDGothic","BIZ UDMincho",
  "MS PGothic","MS Gothic","MS PMincho","MS Mincho",
  "Noto Sans JP","Noto Serif JP","Klee One","Osaka",
  "Tsukushi A Round Gothic","Toppan Bunkyu Gothic","Toppan Bunkyu Mincho"
];
const GOTHIC_DEFAULTS = [   // 既定にしたい太めのゴシック（見つかった最初のもの）
  "Hiragino Kaku Gothic ProN","Hiragino Sans","Yu Gothic","Meiryo",
  "Noto Sans JP","BIZ UDGothic","MS PGothic","MS Gothic"
];
function fillFontSelect(families){
  const sel = $("fontSel");
  sel.innerHTML = "";
  for(const f of families){
    const op = document.createElement("option");
    op.value = f; op.textContent = f; op.style.fontFamily = `"${f}"`;
    sel.appendChild(op);
  }
  const def = GOTHIC_DEFAULTS.find(f => families.includes(f));
  if(def){ sel.value = def; }
  sel.onchange = () => {
    $("msg").style.fontFamily = `"${sel.value}", sans-serif`;
    $("msg").style.fontWeight = "700";           // 太めを基準に
  };
  sel.onchange();
}
async function loadLocalFonts(){
  if(!("queryLocalFonts" in window)){
    setStatus("この環境では端末フォントの一覧取得に未対応です（Chrome / Edge で開いてください）。");
    return;
  }
  try{
    const fonts = await window.queryLocalFonts();
    const fams = [...new Set(fonts.map(f => f.family))]
      .filter(supportsJapanese)                   // 日本語対応フォントだけ
      .sort((a, b) => a.localeCompare(b, "ja"));
    if(!fams.length){ setStatus("日本語対応フォントが見つかりませんでした。"); return; }
    fillFontSelect(fams);
    setStatus(`${fams.length} 書体（日本語対応のみ）を読み込みました。`);
  }catch(err){
    setStatus("フォントへのアクセスが許可されませんでした。");
  }
}

let statusTimer = null;
function setStatus(msg){
  $("status").textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $("status").textContent = ""; }, 6000);
}
let toastTimer = null;
function showToast(msg){
  const t = $("toast");
  if(!t){ setStatus(msg); return; }   // 古いhtmlでも壊れないように
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
function updateMeta(){
  $("metaDate").textContent = todayStr();
  const n = state.days.length;
  const c = state.today.entries.length;
  $("metaLayers").textContent = `${n ? n + " 層" : "まだ層はありません"} ／ 今日 ${c} 件`;
}

function addFromInput(){
  const text = $("msg").value.trim();
  if(!text){ showToast("ひとことを入力してください"); return; }
  if(!selectedEmotion){ showToast("いまの感情をひとつ選んでください"); return; }
  const sizeEl = $("sizeSel");
  const size = sizeEl ? (parseInt(sizeEl.value, 10) || 30) : 30;
  spawnEntry(text, $("fontSel").value, selectedEmotion, size);
  $("msg").value = "";
}

/* ---------- 起動 ---------- */
// 要素が見つからなくても起動全体が止まらないようにする安全な登録
function on(id, ev, fn){
  const el = $(id);
  if(el){ el.addEventListener(ev, fn); }
  else{ console.warn(`要素 #${id} が見つかりません。index.html が古い可能性があります。`); }
}
buildEmotionButtons();
let initFonts = FALLBACK_FONTS.filter(f => fontExists(f) && supportsJapanese(f));
if(!initFonts.length){ initFonts = ["Hiragino Kaku Gothic ProN", "Meiryo", "Yu Gothic"]; }
fillFontSelect(initFonts);
on("btnFonts", "click", loadLocalFonts);
on("btnAdd", "click", addFromInput);
on("msg", "keydown", e => {
  // 日本語入力の変換確定Enter（isComposing / keyCode 229）では送信しない
  if(e.key === "Enter" && !e.isComposing && e.keyCode !== 229){ addFromInput(); }
});
on("btnPreview", "click", () => {
  if(!previewDeposit && !state.today.entries.length){
    setStatus("今日はまだ何も積まれていません。"); return;
  }
  previewDeposit = !previewDeposit;
  $("btnPreview").classList.toggle("on", previewDeposit);
  buildStrata();
  setStatus(previewDeposit ? "今日が層になった姿です（保存データは変わりません）。" : "記録の表示に戻りました。");
});
on("btnDir", "click", onFolderButton);
on("btnExport", "click", exportData);
on("btnImport", "click", () => $("importFile") && $("importFile").click());
on("importFile", "change", e => {
  if(e.target.files[0]){ importData(e.target.files[0]); e.target.value = ""; }
});
addEventListener("resize", resize);

(async () => {
  await fetchState();
  await restoreFolder();
  if(STATIC_MODE){
    setStatus("公開版モード: 記録はこのブラウザの中だけに保存されます。");
  }
  resize();
  restoreToday();
  updateMeta();
  checkRollover();
  setInterval(checkRollover, LAYER_INTERVAL === "day" ? 30000 : 3000);  // 短周期テスト時は3秒ごとに監視
  requestAnimationFrame(frame);
})();
