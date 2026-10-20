'use strict';

/* =========================================================================
 * Chat & Souris — chasse à l'homme à deux téléphones.
 *
 * Les deux téléphones communiquent via un serveur MQTT public (WebSocket).
 * Les messages sont chiffrés (AES-GCM) avec une clé dérivée du code de la
 * partie, et le nom du canal est un hash du code : le serveur ne voit rien
 * d'exploitable.
 *
 * L'hôte (celui qui crée la partie) fait autorité sur l'état du jeu. Tous les
 * instants sont exprimés dans l'horloge de l'hôte ; l'invité estime le décalage
 * entre les deux horloges par ping/pong, ce qui synchronise tirage et timers.
 * ======================================================================= */

const DEFAULT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const HEARTBEAT_MS = 4000;
const PEER_TIMEOUT_MS = 12000;
const POS_SEND_MS = 2500;
const DRAW_LEAD_MS = 1200;   // délai entre le clic "tirage" et le début de l'animation
const DRAW_SPIN_MS = 4000;   // durée de l'animation
const DRAW_SHOW_MS = 3500;   // affichage du résultat avant le début de la partie
const TIME_POINTS_PER_GAME = 1000; // points gagnés en restant souris pendant toute la partie
const SHRINK_STEP_MS = 20000;      // mise à jour de la zone qui se rétrécit
const PHOTO_AUTO_ACCEPT_MS = 90000; // photo validée d'office si le chat ne répond pas
const PHOTO_MAX_PX = 640;
const PHOTO_RESEND_MS = 10000;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------- Utilitaires ---------- */

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function randomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function fmt(ms) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`;
}

function fmtCountdown(ms) {
  // arrondi au supérieur : un compte à rebours affiche 00:01 jusqu'à la toute fin
  return fmt(Math.ceil(Math.max(0, ms) / 1000) * 1000);
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function insideZone(zone, p) {
  if (!zone || !p) return true;
  if (zone.type === 'circle') {
    return haversine({ lat: zone.center[0], lng: zone.center[1] }, p) <= zone.radius;
  }
  // lancer de rayon sur le polygone (suffisant à l'échelle d'une zone de jeu)
  let inside = false;
  const pts = zone.points;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [yi, xi] = pts[i];
    const [yj, xj] = pts[j];
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function confirmDialog(text) {
  return new Promise((resolve) => {
    const dlg = $('#confirm');
    $('#confirm-text').textContent = text;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'yes'), { once: true });
    dlg.showModal();
  });
}

function vibrate(pattern) {
  try { navigator.vibrate && navigator.vibrate(pattern); } catch { /* non supporté */ }
}

let audioCtx = null;
function beep(freq = 880, ms = 180, times = 1) {
  if (!audioCtx) return;
  for (let i = 0; i < times; i++) {
    const t0 = audioCtx.currentTime + i * (ms / 1000 + 0.08);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + ms / 1000);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + ms / 1000);
  }
}
document.addEventListener('click', () => {
  if (!audioCtx && window.AudioContext) audioCtx = new AudioContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}, { capture: true });

function alertUser(kind) {
  if (kind === 'phase') { vibrate([300, 100, 300]); beep(990, 200, 2); }
  if (kind === 'role') { vibrate([500, 150, 500, 150, 500]); beep(660, 250, 3); }
  if (kind === 'reveal') { vibrate(120); beep(1320, 90); }
  if (kind === 'photo') { vibrate([150, 80, 150, 80, 400]); beep(1100, 120, 3); }
  if (kind === 'zone') { vibrate([200, 100, 200, 100, 200]); beep(330, 300); }
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* refusé par le navigateur */ }
}

/* ---------- Stockage local ---------- */

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* stockage indisponible */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* stockage indisponible */ }
  },
};

const deviceId = store.get('cs-device') || randomId();
store.set('cs-device', deviceId);

const urlBroker = new URLSearchParams(location.search).get('broker');
const prefs = store.get('cs-prefs', {});
function defaultBroker() { return urlBroker || prefs.broker || DEFAULT_BROKER; }
function savePrefs(patch) { Object.assign(prefs, patch); store.set('cs-prefs', prefs); }

/* ---------- Canal de communication chiffré ---------- */

async function deriveChannel(code) {
  const enc = new TextEncoder();
  const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  const topicBytes = (await sha('chat-souris/topic/' + code)).slice(0, 12);
  const keyBytes = await sha('chat-souris/key/' + code);
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const hex = Array.from(topicBytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return { base: 'chat-souris/v1/' + hex, key };
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

class Link {
  constructor({ broker, code, role, onMessage, onStatus }) {
    Object.assign(this, { broker, code, role, onMessage, onStatus });
    this.client = null;
    this.connected = false;
  }

  async start() {
    const { base, key } = await deriveChannel(this.code);
    this.key = key;
    this.inTopic = base + (this.role === 'host' ? '/g2h' : '/h2g');
    this.outTopic = base + (this.role === 'host' ? '/h2g' : '/g2h');
    this.client = mqtt.connect(this.broker, {
      clientId: 'cs_' + randomId(),
      keepalive: 20,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      clean: true,
    });
    this.client.on('connect', () => {
      this.client.subscribe(this.inTopic, { qos: 1 });
      this.connected = true;
      this.onStatus(true);
    });
    const down = () => { if (this.connected) { this.connected = false; this.onStatus(false); } };
    this.client.on('close', down);
    this.client.on('offline', down);
    this.client.on('error', (e) => console.warn('MQTT', e && e.message));
    this.client.on('message', async (topic, payload) => {
      if (topic !== this.inTopic) return;
      try {
        const raw = unb64(payload.toString());
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, this.key, raw.slice(12));
        this.onMessage(JSON.parse(new TextDecoder().decode(plain)));
      } catch { /* message illisible : ignoré */ }
    });
  }

  async send(msg) {
    if (!this.client || !this.key) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(msg));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, data));
    const raw = new Uint8Array(12 + ct.length);
    raw.set(iv);
    raw.set(ct, 12);
    this.client.publish(this.outTopic, b64(raw), { qos: 1 });
  }

  stop() {
    if (this.client) this.client.end(true);
    this.client = null;
    this.connected = false;
  }
}

/* ---------- Session ---------- */

/*
 * S = {
 *   role: 'host' | 'guest', code, broker, myName, otherName, otherId,
 *   config: {
 *     zone, totalMs, headMs, reveal: 'live'|'interval'|'shrink'|'hidden', revealEveryMs,
 *     shrinkStartM, shrinkEndM, shrinkMs, timeRate (points/min), photoPts, photoCooldownMs
 *   },
 *   game: null | {
 *     v, mouse: 'host'|'guest', drawAt, revealAt, startAt, endAt,
 *     roundId, roundStart, mouseTime: { host, guest }, rounds: [{ mouse, start, end }],
 *     photos: [{ pid, by, roundId, at, pts, status: 'pending'|'ok'|'no' }]
 *   },
 *   offset,        // horloge de l'hôte - horloge locale (0 pour l'hôte)
 *   pendingTag,    // { roundId, at } en attente d'accusé (invité)
 *   pendingPhoto,  // { photo, img, pos } en attente d'accusé (invité)
 * }
 */
let S = null;
let link = null;
let netOk = false;      // connecté au serveur
let peerSeen = 0;       // dernier message reçu de l'autre téléphone (horloge locale)
let syncSamples = [];
let synced = false;
let otherPos = null;    // dernière position de la souris adverse { lat, lng, acc, at, out, roundId }
let reveal = { roundId: 0, k: -1, pos: null };
let myPos = null;
let lastPosSent = 0;
let lastShown = { screen: null, inHead: null, roundId: null, myOut: false, otherOut: false };
let timers = [];
let hint = { roundId: 0, k: -1, center: null, r: 0 }; // zone qui se rétrécit affichée au chat
let photoImgs = {};     // hôte : pid -> { img, pos, sentAt } pour renvoyer les photos au chat invité
let seenPhotos = new Set(); // chat : photos déjà reçues
let verdicts = {};      // chat : pid -> true/false
let photoQueue = [];    // chat : photos à valider
let photoShown = null;  // chat : photo affichée dans la boîte de validation
let photoPins = [];     // chat : positions révélées par les photos { roundId, pos }
let photoStatusSeen = {}; // souris : dernier statut connu de ses photos
let lastPhotoSend = 0;

const hostNow = () => Date.now() + (S ? S.offset || 0 : 0);
const me = () => S.role;
const other = () => (S.role === 'host' ? 'guest' : 'host');
const peerConnected = () => Date.now() - peerSeen < PEER_TIMEOUT_MS;

function save() { if (S) store.set('cs-session', S); }

function startSession(session) {
  S = session;
  save();
  peerSeen = 0;
  synced = S.role === 'host';
  syncSamples = [];
  otherPos = null;
  reveal = { roundId: 0, k: -1, pos: null };
  lastShown = { screen: null, inHead: null, roundId: null, myOut: false, otherOut: false };
  hint = { roundId: 0, k: -1, center: null, r: 0 };
  photoImgs = {};
  seenPhotos = new Set();
  verdicts = {};
  photoQueue = [];
  photoShown = null;
  photoPins = [];
  photoStatusSeen = {};
  if (S.game) for (const p of S.game.photos || []) photoStatusSeen[p.pid] = p.status;
  link = new Link({
    broker: S.broker,
    code: S.code,
    role: S.role,
    onMessage: handleMessage,
    onStatus: (ok) => {
      netOk = ok;
      if (ok && S && S.role === 'guest') sendHello();
      renderLobby();
    },
  });
  link.start().catch((e) => toast('Connexion impossible : ' + e.message));
  timers.push(setInterval(heartbeat, HEARTBEAT_MS));
  timers.push(setInterval(tick, 100));
  if (S.role === 'guest') timers.push(setInterval(guestHousekeeping, 2000));
  startGeolocation();
  keepAwake(true);
  tick();
}

function endSession(notify = true) {
  if (notify && link && netOk && currentScreen !== 'end') link.send({ t: 'bye', id: deviceId, to: S.otherId || undefined });
  timers.forEach(clearInterval);
  timers = [];
  if (link) link.stop();
  link = null;
  S = null;
  store.del('cs-session');
  stopGeolocation();
  keepAwake(false);
  if (gameMap) gameMap.remove();
  if (mouseMap) mouseMap.remove();
  gameMap = mouseMap = null;
  fittedRound = null;
  $('#mouse-map-wrap').classList.add('hidden');
  $('#btn-mouse-map').textContent = 'Voir la zone';
  $('#draw-wheel').classList.remove('final');
  if ($('#photo-dialog').open) { photoShown = null; $('#photo-dialog').close(); }
  refreshHome();
  show('home');
}

function sendHello() {
  link.send({ t: 'hello', id: deviceId, name: S.myName });
}

function heartbeat() {
  if (!link || !netOk) return;
  const msg = { t: 'hb', id: deviceId };
  if (S.role === 'host') {
    msg.to = S.otherId;
    msg.game = S.game;
  }
  link.send(msg);
  maybeSendPos(true);
  if (S.role === 'host') hostResendPhotos();
}

function guestHousekeeping() {
  if (!netOk) return;
  // pas encore accueilli par l'hôte : on se ré-annonce
  if (!S.config || !peerConnected()) sendHello();
  // resynchronisation périodique de l'horloge
  if (S.config && (!synced || Math.random() < 0.05)) sendPing();
  // accusé de "touché" pas encore reçu
  if (S.pendingTag) link.send({ t: 'tag', id: deviceId, ...S.pendingTag });
  // photo pas encore reçue par l'hôte
  if (S.pendingPhoto && Date.now() - lastPhotoSend > PHOTO_RESEND_MS) sendPendingPhoto();
  // verdict sur une photo pas encore pris en compte par l'hôte
  for (const p of (S.game && S.game.photos) || []) {
    if (p.status === 'pending' && p.pid in verdicts) link.send({ t: 'verdict', id: deviceId, pid: p.pid, ok: verdicts[p.pid] });
  }
}

function sendPing() {
  for (let i = 0; i < 4; i++) setTimeout(() => link && link.send({ t: 'ping', id: deviceId, c: Date.now() }), i * 300);
}

function handleMessage(msg) {
  if (!S) return;
  if (S.role === 'host') {
    if (msg.t === 'hello') {
      if (S.otherId && S.otherId !== msg.id) {
        link.send({ t: 'full', to: msg.id });
        return;
      }
      const isNew = !S.otherId;
      S.otherId = msg.id;
      S.otherName = msg.name;
      peerSeen = Date.now();
      save();
      link.send({ t: 'welcome', to: msg.id, hostName: S.myName, code: S.code, config: S.config, game: S.game });
      if (isNew) { toast(`${msg.name} a rejoint la partie`); vibrate(100); }
      renderLobby();
      return;
    }
    if (msg.id !== S.otherId) return;
    peerSeen = Date.now();
    if (msg.t === 'ping') link.send({ t: 'pong', to: msg.id, c: msg.c, h: Date.now() });
    else if (msg.t === 'pos') receivePos(msg.p);
    else if (msg.t === 'hb') renderLobby();
    else if (msg.t === 'bye') { toast(`${S.otherName} a quitté la partie`, 4000); endSession(false); }
    else if (msg.t === 'tag') {
      hostApplyTag(msg.roundId, msg.at);
      link.send({ t: 'game', to: S.otherId, game: S.game });
    } else if (msg.t === 'photo') {
      hostAddPhoto(msg.photo, msg.img, msg.pos);
      link.send({ t: 'game', to: S.otherId, game: S.game });
    } else if (msg.t === 'verdict') {
      hostResolvePhoto(msg.pid, msg.ok);
    }
    return;
  }

  // côté invité
  if (msg.to && msg.to !== deviceId) return;
  if (msg.t === 'full') {
    toast('Cette partie a déjà deux joueurs.', 4000);
    endSession(false);
    return;
  }
  peerSeen = Date.now();
  if (msg.t === 'welcome') {
    const first = !S.config;
    S.config = msg.config;
    S.otherName = msg.hostName;
    applyGame(msg.game);
    save();
    if (first) sendPing();
    renderLobby();
  } else if (msg.t === 'pong') {
    const now = Date.now();
    const rtt = now - msg.c;
    syncSamples.push({ rtt, offset: msg.h + rtt / 2 - now });
    syncSamples = syncSamples.slice(-10);
    const best = syncSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    S.offset = best.offset;
    synced = true;
    save();
  } else if (msg.t === 'hb' || msg.t === 'game') {
    if (msg.game !== undefined) applyGame(msg.game);
    renderLobby();
  } else if (msg.t === 'pos') {
    receivePos(msg.p);
  } else if (msg.t === 'photo') {
    hunterReceivePhoto(msg.photo, msg.img, msg.pos);
  } else if (msg.t === 'bye') {
    toast("L'hôte a quitté la partie", 4000);
    endSession(false);
  }
}

function applyGame(game) {
  if (!game) return;
  if (S.game && S.game.v > game.v) return;
  const prevRound = S.game && S.game.roundId;
  S.game = game;
  if (S.pendingTag && game.roundId > S.pendingTag.roundId) S.pendingTag = null;
  if (S.pendingPhoto && (game.roundId !== S.pendingPhoto.photo.roundId ||
    (game.photos || []).some((p) => p.pid === S.pendingPhoto.photo.pid))) S.pendingPhoto = null;
  if (prevRound && prevRound !== game.roundId) otherPos = null;
  save();
}

function receivePos(p) {
  if (!S.game || !p || p.roundId !== S.game.roundId) return;
  if (S.game.mouse !== other()) return;
  otherPos = p;
}

/* ---------- Géolocalisation ---------- */

let geoWatch = null;
function startGeolocation() {
  if (!('geolocation' in navigator) || geoWatch !== null) return;
  geoWatch = navigator.geolocation.watchPosition(
    (pos) => {
      myPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      maybeSendPos(false);
    },
    (err) => {
      if (err.code === 1) toast('Active la localisation pour jouer !', 5000);
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 }
  );
}

function stopGeolocation() {
  if (geoWatch !== null) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = null;
}

function maybeSendPos(force) {
  if (!S || !S.game || !myPos || !link || !netOk) return;
  // seule la souris envoie sa position
  if (S.game.mouse !== me()) return;
  const now = Date.now();
  if (!force && now - lastPosSent < POS_SEND_MS) return;
  lastPosSent = now;
  link.send({
    t: 'pos',
    id: deviceId,
    to: S.role === 'host' ? S.otherId : undefined,
    p: { ...myPos, at: hostNow(), out: !insideZone(S.config.zone, myPos), roundId: S.game.roundId },
  });
}

/* ---------- Logique de jeu ---------- */

function hostStartDraw() {
  const now = hostNow();
  const pick = crypto.getRandomValues(new Uint8Array(1))[0] & 1;
  const drawAt = now + DRAW_LEAD_MS;
  const revealAt = drawAt + DRAW_SPIN_MS;
  const startAt = revealAt + DRAW_SHOW_MS;
  S.game = {
    v: 1,
    mouse: pick ? 'host' : 'guest',
    drawAt,
    revealAt,
    startAt,
    endAt: startAt + S.config.totalMs,
    roundId: 1,
    roundStart: startAt,
    mouseTime: { host: 0, guest: 0 },
    rounds: [],
    photos: [],
  };
  save();
  link.send({ t: 'game', to: S.otherId, game: S.game });
}

function hostApplyTag(roundId, at) {
  const g = S.game;
  if (!g || roundId !== g.roundId) return;
  const headEnd = g.roundStart + S.config.headMs;
  const end = Math.min(hostNow(), g.endAt);
  if (end <= headEnd) return;
  at = Math.min(Math.max(at, headEnd), end);
  g.mouseTime[g.mouse] += at - g.roundStart;
  g.rounds.push({ mouse: g.mouse, start: g.roundStart, end: at });
  g.mouse = g.mouse === 'host' ? 'guest' : 'host';
  g.roundStart = at;
  g.roundId += 1;
  g.v += 1;
  otherPos = null;
  save();
}

function declareTagged() {
  const g = S.game;
  const now = hostNow();
  if (!g || g.mouse !== me() || now >= g.endAt || now < g.roundStart + S.config.headMs) return;
  if (S.role === 'host') {
    hostApplyTag(g.roundId, now);
    link.send({ t: 'game', to: S.otherId, game: S.game });
  } else {
    S.pendingTag = { roundId: g.roundId, at: now };
    save();
    link.send({ t: 'tag', id: deviceId, ...S.pendingTag });
  }
}

function currentScores(now) {
  const g = S.game;
  const t = Math.min(now, g.endAt);
  const s = { ...g.mouseTime };
  if (t > g.roundStart) s[g.mouse] += t - g.roundStart;
  return s;
}

function timeRate() {
  return S.config.timeRate || TIME_POINTS_PER_GAME / (S.config.totalMs / 60e3);
}

// points = temps passé en souris x taux + photos validées
// (en fin de partie, une photo encore en attente de validation compte)
function currentPoints(now) {
  const g = S.game;
  const ended = now >= g.endAt;
  const times = currentScores(now);
  const out = {};
  for (const side of ['host', 'guest']) {
    const photos = (g.photos || []).filter((p) => p.by === side && (p.status === 'ok' || (ended && p.status === 'pending')));
    const timePts = Math.floor((times[side] / 60e3) * timeRate());
    const photoPts = photos.reduce((a, p) => a + p.pts, 0);
    out[side] = { time: times[side], timePts, photos: photos.length, photoPts, total: timePts + photoPts };
  }
  return out;
}

/* ---------- Photos du chat ---------- */

function photoState(now) {
  const g = S.game;
  const c = S.config;
  if (!c.photoPts || g.mouse !== me()) return { show: false };
  if (now < g.roundStart + c.headMs || now >= g.endAt) return { show: false };
  const mine = (g.photos || []).filter((p) => p.by === me() && p.roundId === g.roundId);
  if ((S.pendingPhoto && S.pendingPhoto.photo.roundId === g.roundId) || mine.some((p) => p.status === 'pending')) {
    return { show: true, ok: false, msg: 'Photo envoyée, en attente de validation du chat…' };
  }
  const next = Math.max(-Infinity, ...mine.map((p) => p.at)) + c.photoCooldownMs;
  if (now < next) return { show: true, ok: false, msg: `Prochaine photo possible dans ${fmtCountdown(next - now)}` };
  return { show: true, ok: true, msg: '' };
}

function compressPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, PHOTO_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.6));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image illisible')); };
    img.src = url;
  });
}

function submitPhoto(img) {
  const g = S.game;
  const now = hostNow();
  if (!photoState(now).ok) return;
  const photo = { pid: randomId(), by: me(), roundId: g.roundId, at: now, pts: S.config.photoPts, status: 'pending' };
  const pos = myPos ? { ...myPos, at: now } : null;
  if (S.role === 'host') {
    hostAddPhoto(photo, img, pos);
    link.send({ t: 'game', to: S.otherId, game: S.game });
  } else {
    S.pendingPhoto = { photo, img, pos };
    save();
    sendPendingPhoto();
  }
  toast('📸 Photo envoyée au chat');
}

function sendPendingPhoto() {
  lastPhotoSend = Date.now();
  link.send({ t: 'photo', id: deviceId, ...S.pendingPhoto });
}

function hostAddPhoto(photo, img, pos) {
  const g = S.game;
  if (!g || !photo || (g.photos || []).some((p) => p.pid === photo.pid)) return;
  if (photo.roundId !== g.roundId || photo.by !== g.mouse) return;
  const now = hostNow();
  if (now >= g.endAt) return;
  g.photos = g.photos || [];
  g.photos.push({ ...photo, at: Math.min(photo.at, now), pts: S.config.photoPts, status: 'pending' });
  g.v += 1;
  save();
  photoImgs[photo.pid] = { img, pos, sentAt: 0 };
  if (photo.by === 'guest') hunterReceivePhoto(photo, img, pos);
  else hostResendPhotos();
}

// l'hôte est la souris : renvoie la photo au chat tant qu'il ne l'a pas jugée
function hostResendPhotos() {
  const g = S.game;
  if (!g || !S.otherId) return;
  for (const p of g.photos || []) {
    const data = photoImgs[p.pid];
    if (p.by !== 'host' || p.status !== 'pending' || !data) continue;
    if (Date.now() - data.sentAt < PHOTO_RESEND_MS) continue;
    data.sentAt = Date.now();
    link.send({ t: 'photo', to: S.otherId, photo: p, img: data.img, pos: data.pos });
  }
}

function hostResolvePhoto(pid, ok) {
  const p = ((S.game && S.game.photos) || []).find((x) => x.pid === pid);
  if (!p || p.status !== 'pending' || hostNow() >= S.game.endAt) return;
  p.status = ok ? 'ok' : 'no';
  S.game.v += 1;
  save();
  link.send({ t: 'game', to: S.otherId, game: S.game });
}

function hunterReceivePhoto(photo, img, pos) {
  if (!S.game || !photo) return;
  if (seenPhotos.has(photo.pid)) {
    if (S.role === 'guest' && photo.pid in verdicts) link.send({ t: 'verdict', id: deviceId, pid: photo.pid, ok: verdicts[photo.pid] });
    return;
  }
  seenPhotos.add(photo.pid);
  if (pos) photoPins.push({ roundId: photo.roundId, pos });
  photoQueue.push({ photo, img });
  alertUser('photo');
  showNextPhoto();
}

function showNextPhoto() {
  const dlg = $('#photo-dialog');
  if (dlg.open || !photoQueue.length) return;
  photoShown = photoQueue.shift();
  $('#photo-img').src = photoShown.img;
  dlg.returnValue = '';
  dlg.showModal();
}

$('#photo-dialog').addEventListener('close', () => {
  const shown = photoShown;
  photoShown = null;
  const dlg = $('#photo-dialog');
  if (shown && S && (dlg.returnValue === 'yes' || dlg.returnValue === 'no')) {
    const ok = dlg.returnValue === 'yes';
    verdicts[shown.photo.pid] = ok;
    if (S.role === 'host') hostResolvePhoto(shown.photo.pid, ok);
    else link.send({ t: 'verdict', id: deviceId, pid: shown.photo.pid, ok });
  } else if (shown && S && dlg.returnValue === '') {
    // fermée sans choix (touche retour) : on la représente
    const p = (S.game.photos || []).find((x) => x.pid === shown.photo.pid);
    if (!p || p.status === 'pending') photoQueue.unshift(shown);
  }
  setTimeout(() => S && showNextPhoto(), 300);
});

// boîte de validation du chat : compte à rebours, fermeture si la photo a déjà été jugée
function renderPhotoDialog(now) {
  const dlg = $('#photo-dialog');
  if (!dlg.open || !photoShown) return;
  const p = (S.game.photos || []).find((x) => x.pid === photoShown.photo.pid);
  if (p && p.status !== 'pending') {
    photoShown = null;
    dlg.close('done');
    return;
  }
  const left = photoShown.photo.at + PHOTO_AUTO_ACCEPT_MS - now;
  $('#photo-auto').textContent = `+${photoShown.photo.pts} pts pour la souris · validée automatiquement dans ${fmtCountdown(left)}`;
}

function hostAutoAcceptPhotos(now) {
  for (const p of (S.game && S.game.photos) || []) {
    if (p.status === 'pending' && now - p.at > PHOTO_AUTO_ACCEPT_MS && now < S.game.endAt) hostResolvePhoto(p.pid, true);
  }
}

// la souris est prévenue quand le chat a jugé sa photo
function notifyPhotoResults() {
  for (const p of S.game.photos || []) {
    const before = photoStatusSeen[p.pid];
    photoStatusSeen[p.pid] = p.status;
    // une photo jamais vue en attente (reprise de partie) ne déclenche pas de notification
    if (p.by !== me() || before === p.status || p.status === 'pending' || before === undefined) continue;
    if (p.status === 'ok') { toast(`📸 Photo validée : +${p.pts} pts !`, 3500); alertUser('reveal'); }
    else toast('📸 Le chat a refusé ta photo', 3500);
  }
}

/* ---------- Écrans ---------- */

let currentScreen = 'home';
function show(name) {
  if (currentScreen === name) return;
  currentScreen = name;
  $$('.screen').forEach((el) => el.classList.toggle('active', el.id === 'screen-' + name));
  if (name === 'zone') initZoneMap();
}

function refreshHome() {
  const saved = store.get('cs-session');
  const resumable = saved && (!saved.game || hostNowFor(saved) < saved.game.endAt + 3600e3);
  $('#btn-resume').classList.toggle('hidden', !resumable);
  if (saved && !resumable) store.del('cs-session');
}

function hostNowFor(session) { return Date.now() + (session.offset || 0); }

$$('[data-back]').forEach((b) => b.addEventListener('click', () => show(b.dataset.back)));

/* Accueil */
$('#btn-new').addEventListener('click', () => show('zone'));
$('#btn-join').addEventListener('click', () => {
  const f = $('#join-form');
  f.name.value = prefs.name || '';
  f.broker.value = defaultBroker();
  show('join');
});
$('#btn-resume').addEventListener('click', () => {
  const saved = store.get('cs-session');
  if (saved) startSession(saved);
});

/* Zone de jeu */
let zoneMap = null;
let zoneMode = 'circle';
let zoneCenter = null;
let zoneRadius = 500;
let zonePoints = [];
let zoneLayer = null;

function tileLayer() {
  return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  });
}

function zoneToLayer(zone, style = {}) {
  const opts = { color: '#ffb020', weight: 3, fillOpacity: 0.08, ...style };
  if (zone.type === 'circle') return L.circle(zone.center, { radius: zone.radius, ...opts });
  return L.polygon(zone.points, opts);
}

function zoneBounds(zone) {
  if (zone.type === 'circle') return L.latLng(zone.center).toBounds(zone.radius * 2);
  return L.latLngBounds(zone.points);
}

function currentZone() {
  if (zoneMode === 'circle') return zoneCenter ? { type: 'circle', center: zoneCenter, radius: zoneRadius } : null;
  return zonePoints.length >= 3 ? { type: 'polygon', points: zonePoints.slice() } : null;
}

function drawZoneEditor() {
  if (zoneLayer) zoneLayer.remove();
  zoneLayer = L.layerGroup().addTo(zoneMap);
  if (zoneMode === 'circle' && zoneCenter) {
    zoneToLayer({ type: 'circle', center: zoneCenter, radius: zoneRadius }).addTo(zoneLayer);
    L.circleMarker(zoneCenter, { radius: 5, color: '#ffb020', fillOpacity: 1 }).addTo(zoneLayer);
  }
  if (zoneMode === 'polygon' && zonePoints.length) {
    if (zonePoints.length >= 3) zoneToLayer({ type: 'polygon', points: zonePoints }).addTo(zoneLayer);
    else L.polyline(zonePoints, { color: '#ffb020', weight: 3, dashArray: '6 6' }).addTo(zoneLayer);
    zonePoints.forEach((p) => L.circleMarker(p, { radius: 6, color: '#ffb020', fillOpacity: 1 }).addTo(zoneLayer));
  }
  $('#zone-next').disabled = !currentZone();
}

function locate(map, zoom = 16) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], zoom),
    () => toast('Position introuvable'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

function initZoneMap() {
  if (zoneMap) { setTimeout(() => zoneMap.invalidateSize(), 50); return; }
  zoneMap = L.map('zone-map', { zoomControl: false }).setView([48.8566, 2.3522], 13);
  tileLayer().addTo(zoneMap);
  zoneMap.on('click', (e) => {
    const p = [e.latlng.lat, e.latlng.lng];
    if (zoneMode === 'circle') zoneCenter = p;
    else zonePoints.push(p);
    drawZoneEditor();
  });
  locate(zoneMap);
  setTimeout(() => zoneMap.invalidateSize(), 50);
}

$$('#zone-mode button').forEach((b) => b.addEventListener('click', () => {
  zoneMode = b.dataset.mode;
  $$('#zone-mode button').forEach((x) => x.classList.toggle('active', x === b));
  $('#zone-circle-tools').classList.toggle('hidden', zoneMode !== 'circle');
  $('#zone-polygon-tools').classList.toggle('hidden', zoneMode !== 'polygon');
  drawZoneEditor();
}));
$('#radius').addEventListener('input', (e) => {
  zoneRadius = Number(e.target.value);
  $('#radius-out').textContent = fmtDist(zoneRadius);
  drawZoneEditor();
});
$('#poly-undo').addEventListener('click', () => { zonePoints.pop(); drawZoneEditor(); });
$('#poly-clear').addEventListener('click', () => { zonePoints = []; drawZoneEditor(); });
$('#zone-locate').addEventListener('click', () => locate(zoneMap));
$('#zone-next').addEventListener('click', () => {
  const f = $('#settings-form');
  f.name.value = prefs.name || '';
  for (const k of SETTING_FIELDS) if (prefs[k] != null) f[k].value = prefs[k];
  f.broker.value = defaultBroker();
  updateRevealField();
  show('settings');
});

/* Paramètres */
const SETTING_FIELDS = ['total', 'head', 'reveal', 'revealEvery', 'shrinkStart', 'shrinkEnd', 'shrinkDur', 'photoPts', 'photoCooldown'];

function updateRevealField() {
  const f = $('#settings-form');
  $('#reveal-every-wrap').classList.toggle('hidden', f.reveal.value !== 'interval');
  $('#shrink-wrap').classList.toggle('hidden', f.reveal.value !== 'shrink');
  const total = Number(f.total.value) || 60;
  const rate = TIME_POINTS_PER_GAME / total;
  $('#rate-hint').textContent = `En souris tu gagnes ${rate.toFixed(1).replace('.0', '')} pts/min ` +
    `(${TIME_POINTS_PER_GAME} pts si tu restes souris toute la partie). Le gagnant est celui qui a le plus de points.`;
}
$('#settings-form').reveal.addEventListener('change', updateRevealField);
$('#settings-form').total.addEventListener('input', updateRevealField);
$('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const total = Number(f.total.value);
  const head = Number(f.head.value);
  if (head >= total) { toast("L'avance doit être plus courte que la partie."); return; }
  const shrinkStart = Number(f.shrinkStart.value) || 500;
  const shrinkEnd = Math.min(Number(f.shrinkEnd.value) || 30, shrinkStart);
  const broker = f.broker.value.trim() || DEFAULT_BROKER;
  const saved = { name: f.name.value.trim(), broker };
  for (const k of SETTING_FIELDS) saved[k] = f[k].value;
  savePrefs(saved);
  startSession({
    role: 'host',
    code: randomCode(),
    broker,
    myName: f.name.value.trim(),
    otherName: null,
    otherId: null,
    config: {
      zone: currentZone(),
      totalMs: total * 60e3,
      headMs: head * 60e3,
      reveal: f.reveal.value,
      revealEveryMs: Math.max(0.5, Number(f.revealEvery.value) || 2) * 60e3,
      shrinkStartM: shrinkStart,
      shrinkEndM: shrinkEnd,
      shrinkMs: Math.max(0.5, Number(f.shrinkDur.value) || 10) * 60e3,
      timeRate: TIME_POINTS_PER_GAME / total,
      photoPts: Math.max(0, Math.round(Number(f.photoPts.value) || 0)),
      photoCooldownMs: Math.max(0.5, Number(f.photoCooldown.value) || 3) * 60e3,
    },
    game: null,
    offset: 0,
    pendingTag: null,
  });
});

/* Rejoindre */
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  const code = f.code.value.trim().toUpperCase();
  if (code.length !== 6) { toast('Le code fait 6 caractères.'); return; }
  const broker = f.broker.value.trim() || DEFAULT_BROKER;
  savePrefs({ name: f.name.value.trim(), broker });
  startSession({
    role: 'guest',
    code,
    broker,
    myName: f.name.value.trim(),
    otherName: null,
    otherId: null,
    config: null,
    game: null,
    offset: 0,
    pendingTag: null,
  });
});
$('#join-form').code.addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

/* Salon */
function settingsSummary(c) {
  if (!c) return '';
  const rev = {
    live: 'en direct',
    hidden: 'cachée',
    interval: `révélée toutes les ${c.revealEveryMs / 60e3} min`,
    shrink: `zone de ${fmtDist(c.shrinkStartM)} à ${fmtDist(c.shrinkEndM)} en ${c.shrinkMs / 60e3} min`,
  }[c.reveal];
  const zone = c.zone.type === 'circle' ? `cercle de ${fmtDist(c.zone.radius)}` : `polygone de ${c.zone.points.length} points`;
  const rate = (c.timeRate || TIME_POINTS_PER_GAME / (c.totalMs / 60e3)).toFixed(1).replace('.0', '');
  const photo = c.photoPts ? `photo du chat : <b>+${c.photoPts} pts</b> (toutes les ${c.photoCooldownMs / 60e3} min max)` : 'photos désactivées';
  return `Partie de <b>${c.totalMs / 60e3} min</b> · avance de <b>${c.headMs / 60e3} min</b><br>` +
    `Position de la souris pendant la chasse : <b>${rev}</b><br>` +
    `Points : <b>${rate} pts/min</b> en souris · ${photo}<br>Zone : ${zone}`;
}

function renderLobby() {
  if (!S || currentScreen !== 'lobby') return;
  const isHost = S.role === 'host';
  $('#lobby-code').textContent = S.code;
  $('#lobby-share').classList.toggle('hidden', !isHost);
  const st = $('#lobby-status');
  const ready = isHost ? S.otherId && peerConnected() : S.config && peerConnected() && synced;
  if (!netOk) st.textContent = 'Connexion au serveur…';
  else if (!isHost && !S.config) st.textContent = "Recherche de l'hôte…";
  else if (!peerConnected()) st.textContent = isHost ? "En attente de l'autre joueur…" : "L'hôte ne répond plus…";
  else if (!ready) st.textContent = "Synchronisation de l'horloge…";
  else st.textContent = '✅ Les deux téléphones sont connectés';
  st.classList.toggle('ok', !!ready);
  const players = [isHost ? S.myName + ' (toi, hôte)' : S.otherName && S.otherName + ' (hôte)', isHost ? S.otherName : S.myName + ' (toi)']
    .filter(Boolean);
  $('#lobby-players').innerHTML = players.map((p) => `<li>${esc(p)}</li>`).join('');
  $('#lobby-summary').innerHTML = settingsSummary(S.config);
  $('#lobby-draw').classList.toggle('hidden', !isHost);
  $('#lobby-draw').disabled = !ready;
  $('#lobby-wait').classList.toggle('hidden', isHost || !ready);
}

$('#lobby-draw').addEventListener('click', () => {
  if (S && S.role === 'host' && !S.game) hostStartDraw();
});
$('#lobby-share').addEventListener('click', async () => {
  const text = `Rejoins ma partie de Chat & Souris avec le code ${S.code}\n${location.origin + location.pathname}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast('Code copié'); }
  } catch { /* partage annulé */ }
});
$('#lobby-quit').addEventListener('click', async () => {
  if (await confirmDialog('Quitter la partie ?')) endSession();
});

/* Tirage au sort */
function renderDraw(now) {
  const g = S.game;
  const names = { host: S.role === 'host' ? S.myName : S.otherName, guest: S.role === 'guest' ? S.myName : S.otherName };
  const wheel = $('#draw-wheel');
  const result = $('#draw-result');
  if (now < g.revealAt) {
    // l'animation ralentit puis s'arrête pile sur le nom de la souris à revealAt
    const f = Math.max(0, Math.min(1, (now - g.drawAt) / (g.revealAt - g.drawAt)));
    const n = Math.floor(31 * (1 - (1 - f) ** 2.2));
    const order = g.mouse === 'host' ? ['guest', 'host'] : ['host', 'guest'];
    wheel.textContent = '🐭 ' + names[order[(n + 1) % 2]];
    wheel.classList.remove('final');
    result.innerHTML = '';
  } else if (!wheel.classList.contains('final')) {
    wheel.textContent = '🐭 ' + names[g.mouse];
    wheel.classList.add('final');
    result.innerHTML = g.mouse === me()
      ? 'Tu es la <b class="mouse">SOURIS 🐭</b><br>Prépare-toi à fuir !'
      : `Tu es le <b class="cat">CHAT 🐱</b><br>${esc(names[g.mouse])} est la souris.`;
    alertUser('role');
  }
}

/* Partie */
let gameMap = null;
let gameLayers = null;
let mouseMap = null;
let mouseMapLayers = null;
let fittedRound = null;

function myIcon() { return L.divIcon({ className: 'pin pin-me', iconSize: [18, 18] }); }
function mouseIcon(stale) { return L.divIcon({ className: 'pin pin-mouse' + (stale ? ' stale' : ''), iconSize: [24, 24] }); }

function initGameMap() {
  if (gameMap) return;
  gameMap = L.map('game-map', { zoomControl: false });
  gameMap.fitBounds(zoneBounds(S.config.zone), { padding: [20, 20] });
  tileLayer().addTo(gameMap);
  zoneToLayer(S.config.zone).addTo(gameMap);
  gameLayers = {
    me: L.marker([0, 0], { icon: myIcon() }),
    mouse: L.marker([0, 0], { icon: mouseIcon(false) }),
    acc: L.circle([0, 0], { radius: 1, color: '#4ac0ff', weight: 1, fillOpacity: 0.15 }),
    hint: L.circle([0, 0], { radius: 1, color: '#4ac0ff', weight: 3, dashArray: '8 8', fillOpacity: 0.12 }),
    photo: L.marker([0, 0], { icon: L.divIcon({ className: 'pin-photo', html: '📸', iconSize: [26, 26] }) }),
  };
}

function initMouseMap() {
  if (mouseMap) return;
  mouseMap = L.map('mouse-map', { zoomControl: false });
  mouseMap.fitBounds(zoneBounds(S.config.zone), { padding: [20, 20] });
  tileLayer().addTo(mouseMap);
  zoneToLayer(S.config.zone).addTo(mouseMap);
  mouseMapLayers = { me: L.marker([0, 0], { icon: myIcon() }) };
}

function setMarker(map, marker, pos) {
  if (!pos) { marker.remove(); return; }
  marker.setLatLng([pos.lat, pos.lng]);
  if (!map.hasLayer(marker)) marker.addTo(map);
}

function shrinkRadius(sinceHeadEnd) {
  const c = S.config;
  const f = Math.min(1, Math.max(0, sinceHeadEnd / c.shrinkMs));
  return c.shrinkStartM + (c.shrinkEndM - c.shrinkStartM) * f;
}

// petit générateur pseudo-aléatoire déterministe (mulberry32)
function seededRandom(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function offsetPoint(p, meters, angle) {
  const dLat = (meters * Math.cos(angle)) / 111320;
  const dLng = (meters * Math.sin(angle)) / (111320 * Math.cos((p.lat * Math.PI) / 180));
  return { lat: p.lat + dLat, lng: p.lng + dLng };
}

// zone qui se rétrécit : un cercle qui contient la souris sans être centré sur elle,
// recalculé toutes les SHRINK_STEP_MS avec un rayon de plus en plus petit
function shrinkHint(now, headEnd) {
  const g = S.game;
  const k = Math.floor((now - headEnd) / SHRINK_STEP_MS);
  if (hint.roundId !== g.roundId || hint.k !== k || !hint.center) {
    const r = shrinkRadius(k * SHRINK_STEP_MS);
    if (otherPos) {
      const rnd = seededRandom(g.roundId * 100003 + k);
      const center = offsetPoint(otherPos, r * 0.8 * Math.sqrt(rnd()), rnd() * 2 * Math.PI);
      hint = { roundId: g.roundId, k, center, r };
    } else if (hint.roundId !== g.roundId) {
      hint = { roundId: g.roundId, k, center: null, r };
    }
  }
  return { mode: 'shrink', pos: null, zone: hint, next: headEnd + (k + 1) * SHRINK_STEP_MS };
}

function visibleMouse(now) {
  const g = S.game;
  const headEnd = g.roundStart + S.config.headMs;
  if (now < headEnd || S.config.reveal === 'live') return { pos: otherPos, mode: 'live' };
  if (S.config.reveal === 'hidden') return { pos: null, mode: 'hidden' };
  if (S.config.reveal === 'shrink') return shrinkHint(now, headEnd);
  const every = S.config.revealEveryMs;
  const k = Math.floor((now - headEnd) / every);
  if (reveal.roundId !== g.roundId || reveal.k !== k) {
    reveal = { roundId: g.roundId, k, pos: otherPos };
    if (k >= 0 && otherPos) alertUser('reveal');
  } else if (!reveal.pos && otherPos) {
    reveal.pos = otherPos; // la position n'était pas encore arrivée au moment de la révélation
  }
  return { pos: reveal.pos, mode: 'interval', next: headEnd + (k + 1) * every };
}

function renderGame(now) {
  const g = S.game;
  const isMouse = g.mouse === me();
  const headEnd = g.roundStart + S.config.headMs;
  const inHead = now < headEnd;
  const pts = currentPoints(now);
  notifyPhotoResults();
  renderPhotoDialog(now);

  // alertes de changement de rôle / de phase
  if (lastShown.roundId !== null && lastShown.roundId !== g.roundId) {
    alertUser('role');
    if (gameMap) setTimeout(() => gameMap && gameMap.invalidateSize(), 50);
    toast(isMouse ? 'Tu as été touché : tu deviens la SOURIS 🐭' : 'Souris touchée ! Tu deviens le CHAT 🐱', 4000);
  } else if (lastShown.inHead === true && !inHead && lastShown.roundId === g.roundId) {
    alertUser('phase');
    toast(isMouse ? 'La chasse commence !' : 'À toi de chasser !');
  }
  lastShown.roundId = g.roundId;
  lastShown.inHead = inHead;

  const role = $('#game-role');
  role.textContent = isMouse ? 'Tu es la SOURIS 🐭' : 'Tu es le CHAT 🐱';
  role.className = 'role ' + (isMouse ? 'mouse' : 'cat');
  $('#game-left').textContent = fmtCountdown(g.endAt - now);
  $('#score-me').textContent = pts[me()].total + ' pts';
  $('#score-other').textContent = pts[other()].total + ' pts';
  $('#score-other-label').textContent = S.otherName || 'Adversaire';
  $('#net-dot').classList.toggle('ok', netOk && peerConnected());

  // sortie de zone
  const myOut = myPos ? !insideZone(S.config.zone, myPos) : false;
  const otherOut = !isMouse && otherPos && otherPos.out;
  if (myOut && !lastShown.myOut) alertUser('zone');
  lastShown.myOut = myOut;
  const alert = $('#zone-alert');
  alert.classList.toggle('hidden', !myOut && !otherOut);
  alert.textContent = myOut ? '⚠️ Tu es hors de la zone de jeu !' : '⚠️ La souris est hors de la zone !';

  $('#hunter-view').classList.toggle('hidden', isMouse);
  $('#mouse-view').classList.toggle('hidden', !isMouse);

  if (isMouse) {
    $('#mouse-phase-label').textContent = inHead ? 'Fuis ! Chasse dans' : 'Temps restant';
    $('#mouse-timer').textContent = fmtCountdown(inHead ? headEnd - now : g.endAt - now);
    const rate = timeRate().toFixed(1).replace('.0', '');
    let sub = inHead ? 'Le chat voit ta position en direct pendant ta fuite.' : `${pts[me()].total} pts · tu gagnes ${rate} pts/min`;
    if (!inHead && S.config.reveal === 'shrink') {
      const step = Math.floor((now - headEnd) / SHRINK_STEP_MS) * SHRINK_STEP_MS;
      sub += ` · le chat voit une zone de ${fmtDist(shrinkRadius(step))}`;
    }
    $('#mouse-sub').textContent = sub;
    const ph = photoState(now);
    const pbtn = $('#btn-photo');
    pbtn.classList.toggle('hidden', !ph.show);
    pbtn.disabled = !ph.ok;
    pbtn.textContent = `📸 Photo du chat (+${S.config.photoPts} pts)`;
    $('#photo-status').textContent = ph.show ? ph.msg || 'Visage du chat visible · la photo révèle ta position' : '';
    const btn = $('#btn-tagged');
    btn.classList.toggle('hidden', inHead);
    const pending = S.pendingTag && S.pendingTag.roundId === g.roundId;
    btn.disabled = !!pending;
    btn.textContent = pending ? 'Envoi…' : 'Je suis touché !';
    if (mouseMap && !$('#mouse-map-wrap').classList.contains('hidden')) setMarker(mouseMap, mouseMapLayers.me, myPos);
    return;
  }

  initGameMap();
  const vis = visibleMouse(now);
  const phase = $('#hunter-phase');
  phase.textContent = inHead ? `La souris s'enfuit · chasse dans ${fmtCountdown(headEnd - now)}` : '🐱 CHASSE ! Trouve la souris';
  setMarker(gameMap, gameLayers.me, myPos);
  const pos = vis.pos;
  setMarker(gameMap, gameLayers.mouse, pos);
  setMarker(gameMap, gameLayers.acc, pos);
  const z = vis.mode === 'shrink' ? vis.zone : null;
  setMarker(gameMap, gameLayers.hint, z && z.center);
  if (z && z.center) {
    gameLayers.hint.setRadius(z.r);
    if (fittedRound !== g.roundId) {
      fittedRound = g.roundId;
      gameMap.fitBounds(gameLayers.hint.getBounds().pad(0.2), { maxZoom: 17 });
    }
  }
  const pin = photoPins.filter((p) => p.roundId === g.roundId).pop();
  setMarker(gameMap, gameLayers.photo, pin && pin.pos);
  if (pos) {
    gameLayers.acc.setRadius(pos.acc || 1);
    const stale = vis.mode === 'interval' || now - pos.at > 15000;
    if (gameLayers.stale !== stale) { gameLayers.stale = stale; gameLayers.mouse.setIcon(mouseIcon(stale)); }
    if (fittedRound !== g.roundId) {
      fittedRound = g.roundId;
      const b = L.latLngBounds([[pos.lat, pos.lng]]);
      if (myPos) b.extend([myPos.lat, myPos.lng]);
      gameMap.fitBounds(b.pad(0.4), { maxZoom: 17 });
    }
  }
  const info = [];
  if (vis.mode === 'hidden') info.push('Position de la souris cachée.');
  else if (vis.mode === 'shrink') {
    if (!z.center) info.push('En attente de la position de la souris…');
    else info.push(`La souris est dans le cercle de ${fmtDist(z.r)}`);
    info.push(`Nouvelle zone dans ${fmtCountdown(vis.next - now)}`);
  } else if (!pos) info.push('En attente de la position de la souris…');
  else {
    info.push(`Position d'il y a ${fmt(now - pos.at)}`);
    if (myPos) info.push(`Distance : ${fmtDist(haversine(myPos, pos))}`);
  }
  if (vis.mode === 'interval') info.push(`Prochaine révélation dans ${fmtCountdown(vis.next - now)}`);
  if (pin) info.push(`📸 = lieu de la dernière photo (il y a ${fmt(now - pin.pos.at)})`);
  $('#hunter-info').textContent = info.join(' · ');
}

$('#btn-tagged').addEventListener('click', async () => {
  if (await confirmDialog('Le chat t\'a vraiment touché ? Les rôles vont s\'inverser.')) declareTagged();
});
$('#btn-photo').addEventListener('click', () => {
  $('#photo-input').value = '';
  $('#photo-input').click();
});
$('#photo-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // pour pouvoir reprendre une photo identique
  if (!file || !S || !S.game) return;
  try {
    submitPhoto(await compressPhoto(file));
  } catch {
    toast('Impossible de lire la photo');
  }
});
$('#btn-mouse-map').addEventListener('click', () => {
  const wrap = $('#mouse-map-wrap');
  wrap.classList.toggle('hidden');
  $('#btn-mouse-map').textContent = wrap.classList.contains('hidden') ? 'Voir la zone' : 'Cacher la zone';
  if (!wrap.classList.contains('hidden')) {
    initMouseMap();
    setTimeout(() => {
      mouseMap.invalidateSize();
      mouseMap.fitBounds(zoneBounds(S.config.zone), { padding: [20, 20] });
    }, 50);
  }
});

/* Fin */
function renderEnd() {
  const g = S.game;
  const pts = currentPoints(g.endAt);
  const names = { [me()]: S.myName, [other()]: S.otherName };
  const diff = pts[me()].total - pts[other()].total;
  const draw = diff === 0;
  $('#end-emoji').textContent = draw ? '🤝' : diff > 0 ? '🏆' : '😿';
  $('#end-title').textContent = draw ? 'Égalité !' : diff > 0 ? 'Tu as gagné !' : `${S.otherName} a gagné`;
  const winner = draw ? null : diff > 0 ? me() : other();
  $('#end-scores').innerHTML = [me(), other()].map((k) =>
    `<div class="${k === winner ? 'win' : ''}"><span>${esc(names[k])}` +
    `<small>${fmt(pts[k].time)} en souris → ${pts[k].timePts} pts · ${pts[k].photos} photo${pts[k].photos > 1 ? 's' : ''} → ${pts[k].photoPts} pts</small>` +
    `</span><b>${pts[k].total} pts</b></div>`).join('');
  const rounds = g.rounds.concat([{ mouse: g.mouse, start: g.roundStart, end: g.endAt }]);
  $('#end-rounds').innerHTML = rounds.map((r) =>
    `<li>🐭 ${esc(names[r.mouse])} — ${fmt(r.end - r.start)}${r.end < g.endAt ? ' (touché)' : ''}</li>`).join('');
}

$('#end-home').addEventListener('click', () => endSession());
$('#game-quit').addEventListener('click', async () => {
  if (await confirmDialog('Abandonner la partie ? Elle sera terminée pour les deux joueurs.')) endSession();
});

/* Boucle principale : choisit l'écran à partir de l'état et de l'heure de l'hôte */
function tick() {
  if (!S) return;
  const now = hostNow();
  const g = S.game;
  let screen;
  if (!g) screen = 'lobby';
  else if (now < g.startAt) screen = 'draw';
  else if (now < g.endAt) screen = 'game';
  else screen = 'end';

  if (screen !== currentScreen) {
    show(screen);
    if (screen === 'lobby') renderLobby();
    if (screen === 'game') {
      setTimeout(() => {
        if (!gameMap) return;
        gameMap.invalidateSize();
        if (fittedRound === null) gameMap.fitBounds(zoneBounds(S.config.zone), { padding: [20, 20] });
      }, 50);
    }
    if (screen === 'end') {
      renderEnd();
      keepAwake(false);
      alertUser('phase');
      if ($('#photo-dialog').open) { photoShown = null; $('#photo-dialog').close('done'); }
    }
  }
  if (S.role === 'host' && g && screen === 'game') hostAutoAcceptPhotos(now);
  if (screen === 'end' && Math.random() < 0.05) renderEnd(); // un dernier état peut arriver juste après la fin
  if (screen === 'draw') renderDraw(now);
  if (screen === 'game') renderGame(now);
  if (screen === 'lobby' && Math.random() < 0.1) renderLobby();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S) {
    keepAwake(currentScreen !== 'end');
    if (link && netOk) heartbeat();
  }
});

// pas de service worker dans l'APK : les fichiers sont déjà dans l'application
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

refreshHome();
