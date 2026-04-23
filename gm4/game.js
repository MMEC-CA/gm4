// Grand Prix — Multiplayer Racing
// Lobby pattern from gm1: color slots, hold-to-ready, countdown, P2P WebRTC

const SIGNALING_URL = '/gm4/api/signal/ws';
const GW = 1280, GH = 720;

const SLOT_COLORS = [
  '#FF4040', '#4488FF', '#44DD44', '#FFE030',
  '#FF8800', '#00DDDD', '#CC44FF', '#FF88AA'
];
const MAX_SLOTS = 8;
const TOTAL_LAPS = 3;
const COUNTDOWN_DURATION = 3.0;
const HOLD_DURATION = 2.0;

// Track: left side = two 90° corners (rounded-rect), right side = 180° hairpin (semicircle)
const TCX = GW / 2, TCY = GH / 2;
const O_HW = 560, O_HH = 290, O_R = 145;
const I_HW = 310, I_HH = 110, I_R = 70;
const SC_X = TCX + O_HW - O_HH;

const VERSION = '2026-04-23-ai';

// AI car constants
const AI_COUNT = 30;
const AI_SPEED = 255;
const AI_ACCEL = 380;
const AI_TURN_RATE = 2.0;
const AI_AVOID_RADIUS = 55;
const AI_AGGRO_INTERVAL = 15;

// Car constants
const CAR_L = 26, CAR_W = 13;
const MAX_SPEED = 620;   // px/s — faster top speed
const ACCEL = 750;
const BRAKE = 900;
const TURN_RATE = 2.8;   // rad/s (constant angular vel → radius ∝ speed)
const FRICTION_K = 1.8;

// Weapons & collisions
const BULLET_SPEED = 660;
const BULLET_LIFE = 1.4;
const FIRE_RATE = 0.1;
const HIT_RADIUS = 15;
const HIT_COOLDOWN = 0.4;
const HIT_SPIN = 2.5;
const HIT_SPEED_MULT = 0.72;
const HIT_FLASH_DUR = 0.4;
const SPIN_DECAY = 3.0;
const AI_SWERVE_DURATION = 1.0;
const WALL_BOUNCE = 0.33;  // lose 2/3 speed on wall

// Ammo & oil
const RECHARGE_TIME = 5.0;
const MAX_CHARGES = 30;
const OIL_FIRE_RATE = 0.1;
const OIL_LIFE = 1.0;
const OIL_SKID_DURATION = 1.0;
const OIL_RADIUS = 22;
const SKID_LIFE = 4.0;
const CAR_BOUNCE = 0.72;
const CAR_RADIUS = 16;

// Player car damage
const DAMAGE_PER_WALL   = 0.20;
const DAMAGE_PER_BULLET = 0.15;

// Walkers / power-ups
const WALKER_SPEED    = 45;   // px/s vertical
const WALKER_HIT_R    = 14;   // px collision radius
const WALKER_FLARE    = 0.55; // s flare duration after hit

// ============================================================
// STATE
// ============================================================
let lobbyState = 'lobby';
let myPeerId = 'p' + Math.random().toString(36).slice(2, 9);
let mySlotIndex = -1;
let isHost = false;
let slots = Array.from({ length: MAX_SLOTS }, () => ({
  peerId: null, ready: false, progress: 0, holding: false
}));
let countdownTimer = COUNTDOWN_DURATION;
let holdingFlap = false;
let holdStartTime = 0;

let myP2PeerId = myPeerId + '-p2';
let myP2SlotIndex = -1;
let holdingFlapP2 = false;
let holdStartTimeP2 = 0;
let myCarP2 = null;

let sigWs = null;
let pcs = new Map();
let dcs = new Map();

let myCar = null;
let remoteCars = new Map();
let raceStartTime = 0;
let raceGo = false;
let finishOrder = [];
let goFlashTimer = 0;

let aiCars = [];
let aggroTimer = AI_AGGRO_INTERVAL;
let aggroCar = null;

// World effects
let oilSlicks = [];
let skidMarks = [];
let smokeParticles = [];
let walkers = [];
let walkerSpawnTimer = 4;

// Input
const keys = {};
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); onFlapDown(); }
  if (e.code === 'ArrowUp') {
    if (lobbyState === 'lobby' || lobbyState === 'countdown') { e.preventDefault(); onFlapDown(); }
    else if (lobbyState === 'game') e.preventDefault();
  }
  if (e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (lobbyState === 'game') e.preventDefault();
  }
  if (e.code === 'KeyW' && (lobbyState === 'lobby' || lobbyState === 'countdown')) onFlapDownP2();
  if (e.code === 'Tab') e.preventDefault();
  if ((e.code === 'Comma' || e.code === 'Period' || e.code === 'Enter' ||
       e.code === 'BracketLeft' || e.code === 'BracketRight' || e.code === 'Backquote' ||
       e.code === 'KeyC' || e.code === 'KeyV' || e.code === 'Digit1') && lobbyState === 'game') e.preventDefault();
});
document.addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'Space' || e.code === 'ArrowUp') onFlapUp();
  if (e.code === 'KeyW') onFlapUpP2();
});

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = GW;
canvas.height = GH;

function resizeCanvas() {
  const scale = Math.min(window.innerWidth / GW, window.innerHeight / GH);
  canvas.style.width = (GW * scale) + 'px';
  canvas.style.height = (GH * scale) + 'px';
  canvas.style.position = 'absolute';
  canvas.style.left = ((window.innerWidth - GW * scale) / 2) + 'px';
  canvas.style.top = ((window.innerHeight - GH * scale) / 2) + 'px';
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

canvas.addEventListener('touchstart', e => { e.preventDefault(); onFlapDown(); }, { passive: false });
canvas.addEventListener('touchend', e => { e.preventDefault(); onFlapUp(); }, { passive: false });

// ============================================================
// LOBBY MECHANICS
// ============================================================
function onFlapDown() {
  if (lobbyState !== 'lobby') return;
  if (mySlotIndex < 0) claimSlot();
  if (mySlotIndex < 0) return;
  if (slots[mySlotIndex].ready) return;
  if (!holdingFlap) { holdingFlap = true; holdStartTime = performance.now(); slots[mySlotIndex].holding = true; }
}
function onFlapUp() {
  if (!holdingFlap) return;
  holdingFlap = false;
  if (mySlotIndex >= 0 && !slots[mySlotIndex].ready) {
    slots[mySlotIndex].holding = false; slots[mySlotIndex].progress = 0;
    broadcast({ type: 'lobby-release', peerId: myPeerId });
  }
}
function onFlapDownP2() {
  if (lobbyState !== 'lobby') return;
  if (myP2SlotIndex < 0) claimSlotP2();
  if (myP2SlotIndex < 0) return;
  if (slots[myP2SlotIndex].ready) return;
  if (!holdingFlapP2) { holdingFlapP2 = true; holdStartTimeP2 = performance.now(); slots[myP2SlotIndex].holding = true; }
}
function onFlapUpP2() {
  if (!holdingFlapP2) return;
  holdingFlapP2 = false;
  if (myP2SlotIndex >= 0 && !slots[myP2SlotIndex].ready) {
    slots[myP2SlotIndex].holding = false; slots[myP2SlotIndex].progress = 0;
    broadcast({ type: 'lobby-release', peerId: myP2PeerId });
  }
}
function claimSlot() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (!slots[i].peerId) {
      mySlotIndex = i; slots[i].peerId = myPeerId;
      broadcast({ type: 'lobby-join', peerId: myPeerId, slotIndex: i });
      updateHost(); return;
    }
  }
}
function claimSlotP2() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (!slots[i].peerId) {
      myP2SlotIndex = i; slots[i].peerId = myP2PeerId;
      broadcast({ type: 'lobby-join', peerId: myP2PeerId, slotIndex: i });
      updateHost(); return;
    }
  }
}
function updateHost() {
  let hostId = mySlotIndex >= 0 ? myPeerId : null;
  for (let i = 0; i < MAX_SLOTS; i++) {
    const p = slots[i].peerId;
    if (p && (!hostId || p < hostId)) hostId = p;
  }
  isHost = (hostId === myPeerId);
}
function updateHold(dt) {
  if (!holdingFlap || mySlotIndex < 0 || slots[mySlotIndex].ready) return;
  const elapsed = (performance.now() - holdStartTime) / 1000;
  const progress = Math.min(100, (elapsed / HOLD_DURATION) * 100);
  slots[mySlotIndex].progress = progress;
  broadcast({ type: 'lobby-hold', peerId: myPeerId, progress });
  if (progress >= 100) {
    slots[mySlotIndex].ready = true; slots[mySlotIndex].holding = false; holdingFlap = false;
    broadcast({ type: 'lobby-ready', peerId: myPeerId }); checkCountdownStart();
  }
}
function updateHoldP2(dt) {
  if (!holdingFlapP2 || myP2SlotIndex < 0 || slots[myP2SlotIndex].ready) return;
  const elapsed = (performance.now() - holdStartTimeP2) / 1000;
  const progress = Math.min(100, (elapsed / HOLD_DURATION) * 100);
  slots[myP2SlotIndex].progress = progress;
  broadcast({ type: 'lobby-hold', peerId: myP2PeerId, progress });
  if (progress >= 100) {
    slots[myP2SlotIndex].ready = true; slots[myP2SlotIndex].holding = false; holdingFlapP2 = false;
    broadcast({ type: 'lobby-ready', peerId: myP2PeerId }); checkCountdownStart();
  }
}
function checkCountdownStart() {
  if (lobbyState !== 'lobby') return;
  if (slots.some(s => s.ready)) {
    lobbyState = 'countdown'; countdownTimer = COUNTDOWN_DURATION;
    broadcast({ type: 'lobby-countdown' });
  }
}
function updateCountdown(dt) {
  if (lobbyState !== 'countdown') return;
  if (slots.some(s => s.holding && !s.ready)) { countdownTimer = COUNTDOWN_DURATION; return; }
  countdownTimer -= dt;
  if (countdownTimer <= 0 && isHost) {
    const playerSlots = [];
    for (let i = 0; i < MAX_SLOTS; i++) if (slots[i].ready) playerSlots.push({ slotIndex: i, peerId: slots[i].peerId });
    const msg = { type: 'game-start', playerSlots, hostPeerId: myPeerId };
    broadcast(msg); startGame(msg);
  }
}

// ============================================================
// NETWORKING
// ============================================================
function connect(room) {
  const url = room
    ? `${SIGNALING_URL}?room=${encodeURIComponent(room)}&peerId=${myPeerId}`
    : `${SIGNALING_URL}?peerId=${myPeerId}`;
  console.log('[sig] connecting as', myPeerId);
  sigWs = new WebSocket(url);
  sigWs.onopen  = () => console.log('[sig] connected');
  sigWs.onmessage = onSigMsg;
  sigWs.onclose = () => console.log('[sig] disconnected');
}
function onSigMsg(ev) {
  const data = JSON.parse(ev.data);
  if (data.type === 'peers') {
    data.peers.forEach(id => { if (id !== myPeerId && !pcs.has(id) && myPeerId < id) createPc(id, true); });
  } else if (data.type === 'peer-joined') {
    if (data.peerId !== myPeerId && !pcs.has(data.peerId) && myPeerId < data.peerId) createPc(data.peerId, true);
  } else if (data.type === 'peer-left') {
    cleanupPeer(data.peerId);
  } else if (data.type === 'signal') {
    handleSignal(data.from, data.signal);
  }
}
const pendingCandidates = new Map();
function createPc(peerId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pcs.set(peerId, pc);
  pc.onicecandidate = e => { if (e.candidate) sendSig(peerId, e.candidate.toJSON()); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') cleanupPeer(peerId);
  };
  const dc = pc.createDataChannel('game', { negotiated: true, id: 0 });
  dcs.set(peerId, dc);
  dc.onopen = () => {
    console.log('[rtc] data channel open with', peerId);
    dc.send(JSON.stringify({ type: 'lobby-sync', slots: slots.map((s, i) => ({ ...s, index: i })), lobbyState, countdownTimer }));
  };
  dc.onmessage = e => handleMsg(peerId, JSON.parse(e.data));
  if (initiator) pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => sendSig(peerId, pc.localDescription));
}
function flushCandidates(peerId) {
  const pc = pcs.get(peerId); const pending = pendingCandidates.get(peerId);
  if (pc && pc.remoteDescription && pending) { pending.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c))); pendingCandidates.delete(peerId); }
}
function handleSignal(from, sig) {
  let pc = pcs.get(from);
  if (!pc) { createPc(from, false); pc = pcs.get(from); }
  if (sig.type === 'offer') {
    pc.setRemoteDescription(new RTCSessionDescription(sig)).then(() => pc.createAnswer()).then(a => pc.setLocalDescription(a)).then(() => { sendSig(from, pc.localDescription); flushCandidates(from); });
  } else if (sig.type === 'answer') {
    pc.setRemoteDescription(new RTCSessionDescription(sig)).then(() => flushCandidates(from));
  } else if (sig.candidate !== undefined) {
    if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(sig));
    else { if (!pendingCandidates.has(from)) pendingCandidates.set(from, []); pendingCandidates.get(from).push(sig); }
  }
}
function sendSig(to, signal) { if (sigWs?.readyState === WebSocket.OPEN) sigWs.send(JSON.stringify({ type: 'signal', to, signal })); }
function cleanupPeer(peerId) {
  pcs.get(peerId)?.close(); pcs.delete(peerId); dcs.delete(peerId);
  remoteCars.delete(peerId); remoteCars.delete(peerId + '-p2');
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i].peerId === peerId || slots[i].peerId === peerId + '-p2')
      slots[i] = { peerId: null, ready: false, progress: 0, holding: false };
  }
  updateHost();
  if (lobbyState === 'countdown' && !slots.some(s => s.ready)) lobbyState = 'lobby';
}
function broadcast(msg) { const s = JSON.stringify(msg); dcs.forEach(dc => { if (dc.readyState === 'open') dc.send(s); }); }

function handleMsg(from, data) {
  switch (data.type) {
    case 'lobby-sync': {
      let p1Yielded = false, p2Yielded = false;
      data.slots.forEach(s => {
        if (!s.peerId || s.peerId === myPeerId || s.peerId === myP2PeerId) return;
        if (mySlotIndex === s.index) {
          if (myPeerId > s.peerId) { slots[mySlotIndex] = { peerId: null, ready: false, progress: 0, holding: false }; mySlotIndex = -1; p1Yielded = true; } else return;
        }
        if (myP2SlotIndex === s.index) {
          if (myP2PeerId > s.peerId) { slots[myP2SlotIndex] = { peerId: null, ready: false, progress: 0, holding: false }; myP2SlotIndex = -1; p2Yielded = true; } else return;
        }
        slots[s.index].peerId = s.peerId; slots[s.index].ready = s.ready; slots[s.index].progress = s.progress;
      });
      if (data.lobbyState === 'countdown' && lobbyState === 'lobby') { lobbyState = 'countdown'; countdownTimer = data.countdownTimer ?? COUNTDOWN_DURATION; }
      updateHost();
      if (p1Yielded) claimSlot(); if (p2Yielded) claimSlotP2();
      break;
    }
    case 'lobby-join':
      if (data.peerId !== myPeerId && data.peerId !== myP2PeerId) {
        if (mySlotIndex === data.slotIndex) {
          if (myPeerId > data.peerId) { slots[mySlotIndex] = { peerId: null, ready: false, progress: 0, holding: false }; mySlotIndex = -1; slots[data.slotIndex].peerId = data.peerId; updateHost(); claimSlot(); } break;
        }
        if (myP2SlotIndex === data.slotIndex) {
          if (myP2PeerId > data.peerId) { slots[myP2SlotIndex] = { peerId: null, ready: false, progress: 0, holding: false }; myP2SlotIndex = -1; slots[data.slotIndex].peerId = data.peerId; updateHost(); claimSlotP2(); } break;
        }
        slots[data.slotIndex].peerId = data.peerId; updateHost();
      }
      break;
    case 'lobby-hold':
      for (let i = 0; i < MAX_SLOTS; i++) {
        if (slots[i].peerId === data.peerId) { slots[i].holding = true; slots[i].progress = data.progress; if (lobbyState === 'countdown' && !slots[i].ready) countdownTimer = COUNTDOWN_DURATION; }
      }
      break;
    case 'lobby-ready':
      for (let i = 0; i < MAX_SLOTS; i++) { if (slots[i].peerId === data.peerId) { slots[i].ready = true; slots[i].holding = false; checkCountdownStart(); } }
      break;
    case 'lobby-release':
      for (let i = 0; i < MAX_SLOTS; i++) { if (slots[i].peerId === data.peerId) { slots[i].holding = false; slots[i].progress = 0; } }
      break;
    case 'lobby-countdown':
      if (lobbyState === 'lobby') { lobbyState = 'countdown'; countdownTimer = COUNTDOWN_DURATION; }
      break;
    case 'game-start':
      if (lobbyState !== 'game' && lobbyState !== 'finish') startGame(data);
      break;
    case 'update':
      if (data.peerId !== myPeerId && data.peerId !== myP2PeerId) remoteCars.set(data.peerId, data.car);
      break;
    case 'finished':
      if (!finishOrder.find(f => f.peerId === data.peerId)) finishOrder.push({ peerId: data.peerId, time: data.time });
      break;
    case 'ai-swerve': {
      const ai = aiCars[data.idx];
      if (ai && !ai.exploded && ai.hitCooldown <= 0) { ai.hitCooldown = HIT_COOLDOWN; ai.swerveTimer = AI_SWERVE_DURATION; ai.hitFlash = HIT_FLASH_DUR; ai.spinVel += (data.spinDir || 1) * HIT_SPIN * 2; }
      break;
    }
    case 'ai-explode': {
      const ai = aiCars[data.idx];
      if (ai && !ai.exploded) { ai.exploded = true; ai.finished = true; ai.speed = 0; ai.swerveTimer = 0; ai.explodeTimer = 0.7; }
      break;
    }
    case 'oil-place':
      oilSlicks.push({ x: data.x, y: data.y, life: OIL_LIFE, angle: data.angle || 0, radius: data.big ? OIL_RADIUS * 1.8 : OIL_RADIUS });
      break;
  }
}

// ============================================================
// TRACK GEOMETRY
// ============================================================
function getSector(x, y) {
  const dx = x - TCX, dy = y - TCY;
  const a = Math.atan2(dy, dx);
  const P = Math.PI;
  if (a >= -P / 4 && a < P / 4) return 0;
  if (a >= P / 4 && a < 3 * P / 4) return 1;
  if (a < -3 * P / 4 || a >= 3 * P / 4) return 2;
  return 3;
}
function sdfOuter(px, py) {
  if (px >= SC_X) return Math.sqrt((px - SC_X) ** 2 + (py - TCY) ** 2) - O_HH;
  const lx = TCX - O_HW + O_R, ty = TCY - O_HH + O_R, by = TCY + O_HH - O_R;
  if (px < lx && py < ty) return Math.sqrt((px - lx) ** 2 + (py - ty) ** 2) - O_R;
  if (px < lx && py > by) return Math.sqrt((px - lx) ** 2 + (py - by) ** 2) - O_R;
  return -Math.min(px - (TCX - O_HW), O_HH - Math.abs(py - TCY));
}
function sdfInner(px, py) {
  if (px >= SC_X) return Math.sqrt((px - SC_X) ** 2 + (py - TCY) ** 2) - I_HH;
  const lx = TCX - I_HW + I_R, ty = TCY - I_HH + I_R, by = TCY + I_HH - I_R;
  if (px < lx && py < ty) return Math.sqrt((px - lx) ** 2 + (py - ty) ** 2) - I_R;
  if (px < lx && py > by) return Math.sqrt((px - lx) ** 2 + (py - by) ** 2) - I_R;
  return -Math.min(px - (TCX - I_HW), I_HH - Math.abs(py - TCY));
}
function outerNormal(px, py) {
  const e = 1, dx = sdfOuter(px+e,py)-sdfOuter(px-e,py), dy = sdfOuter(px,py+e)-sdfOuter(px,py-e);
  const len = Math.sqrt(dx*dx+dy*dy); return len < 0.001 ? {nx:1,ny:0} : {nx:dx/len,ny:dy/len};
}
function innerNormal(px, py) {
  const e = 1, dx = sdfInner(px+e,py)-sdfInner(px-e,py), dy = sdfInner(px,py+e)-sdfInner(px,py-e);
  const len = Math.sqrt(dx*dx+dy*dy); return len < 0.001 ? {nx:1,ny:0} : {nx:dx/len,ny:dy/len};
}
function bounceOnWalls(car) {
  let vx = Math.cos(car.angle)*car.speed, vy = Math.sin(car.angle)*car.speed, bounced = false;
  const od = sdfOuter(car.x, car.y);
  if (od > -1) {
    const {nx,ny} = outerNormal(car.x,car.y);
    car.x -= nx*(od+1); car.y -= ny*(od+1);
    const dot = vx*nx+vy*ny;
    if (dot > 0) { vx -= 2*dot*nx; vy -= 2*dot*ny; vx *= WALL_BOUNCE; vy *= WALL_BOUNCE; car.spinVel += (Math.random()-0.5)*2; bounced = true; }
  }
  const id = sdfInner(car.x, car.y);
  if (id < 1) {
    const {nx,ny} = innerNormal(car.x,car.y);
    car.x += nx*(1-id); car.y += ny*(1-id);
    const dot = vx*nx+vy*ny;
    if (dot < 0) { vx -= 2*dot*nx; vy -= 2*dot*ny; vx *= WALL_BOUNCE; vy *= WALL_BOUNCE; car.spinVel += (Math.random()-0.5)*2; bounced = true; }
  }
  if (bounced) {
    car.speed = Math.min(Math.sqrt(vx*vx+vy*vy), MAX_SPEED);
    if (car.speed > 1) car.angle = Math.atan2(vy, vx);
    if (car.damage !== undefined) applyPlayerDamage(car, DAMAGE_PER_WALL);
  }
  return bounced;
}
function getStartPos(index) {
  const col = index % 2, row = Math.floor(index / 2);
  return { x: 835 - row * 55, y: 135 + col * 50, angle: 0 };
}

// ============================================================
// GAME START & CAR CREATION
// ============================================================
function makeCar(slotIndex, posIndex) {
  const pos = getStartPos(posIndex);
  return {
    x: pos.x, y: pos.y, angle: pos.angle, speed: 0,
    prevSector: getSector(pos.x, pos.y),
    nextSector: (getSector(pos.x, pos.y) + 1) % 4,
    sectorsPassed: 0, lap: 0, finished: false, finishTime: 0,
    color: SLOT_COLORS[slotIndex], slotIndex,
    spinVel: 0, hitFlash: 0, hitCooldown: 0, skidTimer: 0,
    damage: 0,
    laserLevel: 0,    // 0=bullets, 1-3=laser beams
    oilUpgraded: 0,   // 0=normal, 1+=wider/more drops
    laserBeams: null,
    fireTimer: 0, bullets: [],
    gunCharges: new Array(MAX_CHARGES).fill(0),
    oilCharges: new Array(MAX_CHARGES).fill(0),
    oilFireTimer: 0,
  };
}

function startGame(msg) {
  lobbyState = 'game';
  isHost = (msg.hostPeerId === myPeerId);
  raceStartTime = performance.now();
  raceGo = false; goFlashTimer = 0; finishOrder = [];
  remoteCars.clear(); oilSlicks = []; skidMarks = []; smokeParticles = [];
  walkers = []; walkerSpawnTimer = 5;

  const playerSlots = msg.playerSlots || [];
  console.log('[game] startGame playerSlots:', JSON.stringify(playerSlots));
  const myEntry = playerSlots.find(ps => ps.peerId === myPeerId);
  if (myEntry) myCar = makeCar(myEntry.slotIndex, playerSlots.indexOf(myEntry));
  const myP2Entry = playerSlots.find(ps => ps.peerId === myP2PeerId);
  if (myP2Entry) myCarP2 = makeCar(myP2Entry.slotIndex, playerSlots.indexOf(myP2Entry));
  initAICars();
  setTimeout(() => { raceGo = true; goFlashTimer = 1.2; }, 3000);
}

// ============================================================
// CAR PHYSICS
// ============================================================
function updateCar(car, dt) {
  car.hitCooldown = Math.max(0, car.hitCooldown - dt);
  car.hitFlash    = Math.max(0, car.hitFlash - dt);
  car.skidTimer   = Math.max(0, car.skidTimer - dt);
  car.spinVel    *= Math.exp(-SPIN_DECAY * dt);
  car.angle      += car.spinVel * dt;

  if (car.finished || !raceGo) return;

  const dmg = car.damage;
  const accelMult = 1 - dmg * 0.50;
  const turnMult  = 1 - dmg * 0.55;
  const maxSpMult = 1 - dmg * 0.30;

  if (keys['ArrowUp']) {
    car.speed = Math.min(car.speed + ACCEL * accelMult * dt, MAX_SPEED * maxSpMult);
  } else if (keys['ArrowDown']) {
    car.speed = Math.max(car.speed - BRAKE * dt, -MAX_SPEED * 0.35);
  } else {
    car.speed *= Math.exp(-FRICTION_K * dt);
    if (Math.abs(car.speed) < 2) car.speed = 0;
  }

  // Turn rate is constant in angular velocity → tighter radius at low speed
  // steerFactor ramps 0→1 below 55 px/s so you need forward motion to steer
  const steerFactor = Math.min(1, Math.abs(car.speed) / 55);
  const turnBase = TURN_RATE * turnMult * steerFactor;
  if (car.skidTimer > 0) {
    if (keys['ArrowLeft'])  car.angle -= turnBase * 0.3 * dt;
    if (keys['ArrowRight']) car.angle += turnBase * 0.3 * dt;
    car.spinVel += (Math.random() - 0.5) * 10 * dt;
    if (Math.random() < dt * 25) skidMarks.push({ x: car.x, y: car.y, life: SKID_LIFE });
  } else {
    if (keys['ArrowLeft'])  car.angle -= turnBase * dt;
    if (keys['ArrowRight']) car.angle += turnBase * dt;
    if (dmg > 0.15) car.spinVel += (Math.random() - 0.5) * dmg * 5 * dt;
  }

  // P1 fire gun — ShiftRight, ControlRight, Slash, Comma, BracketLeft
  const p1Firing = keys['ShiftRight'] || keys['ControlRight'] || keys['Slash'] || keys['Comma'] || keys['BracketLeft'];
  tryFire(car, p1Firing, dt);
  // P1 oil — Period, Enter, BracketRight
  tryOil(car, keys['Period'] || keys['Enter'] || keys['BracketRight'], dt);
  updateBullets(car.bullets, dt);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  bounceOnWalls(car);
  emitSmoke(car, dt);

  if (car.hitFlash > 0 && Math.random() < dt * 20) skidMarks.push({ x: car.x, y: car.y, life: SKID_LIFE });

  const sector = getSector(car.x, car.y);
  if (sector !== car.prevSector && sector === car.nextSector) {
    car.sectorsPassed++;
    car.lap = Math.floor(car.sectorsPassed / 4);
    car.nextSector = (car.nextSector + 1) % 4;
    if (car.lap >= TOTAL_LAPS && !car.finished) {
      car.finished = true;
      car.finishTime = (performance.now() - raceStartTime) / 1000;
      finishOrder.push({ peerId: myPeerId, time: car.finishTime });
      broadcast({ type: 'finished', peerId: myPeerId, time: car.finishTime });
      checkAllFinished();
    }
  }
  car.prevSector = sector;
}

function checkAllFinished() {
  const totalPlayers = slots.filter(s => s.ready).length;
  if (finishOrder.length >= totalPlayers) setTimeout(() => { lobbyState = 'finish'; }, 2000);
}

// P2 car physics — WASD controls
function updateCarP2(car, dt) {
  car.hitCooldown = Math.max(0, car.hitCooldown - dt);
  car.hitFlash    = Math.max(0, car.hitFlash - dt);
  car.skidTimer   = Math.max(0, car.skidTimer - dt);
  car.spinVel    *= Math.exp(-SPIN_DECAY * dt);
  car.angle      += car.spinVel * dt;

  if (car.finished || !raceGo) return;

  const dmg = car.damage;
  const accelMult = 1 - dmg * 0.50;
  const turnMult  = 1 - dmg * 0.55;
  const maxSpMult = 1 - dmg * 0.30;

  if (keys['KeyW']) {
    car.speed = Math.min(car.speed + ACCEL * accelMult * dt, MAX_SPEED * maxSpMult);
  } else if (keys['KeyS']) {
    car.speed = Math.max(car.speed - BRAKE * dt, -MAX_SPEED * 0.35);
  } else {
    car.speed *= Math.exp(-FRICTION_K * dt);
    if (Math.abs(car.speed) < 2) car.speed = 0;
  }

  const steerFactor = Math.min(1, Math.abs(car.speed) / 55);
  const turnBase = TURN_RATE * turnMult * steerFactor;
  if (car.skidTimer > 0) {
    if (keys['KeyA']) car.angle -= turnBase * 0.3 * dt;
    if (keys['KeyD']) car.angle += turnBase * 0.3 * dt;
    car.spinVel += (Math.random() - 0.5) * 10 * dt;
    if (Math.random() < dt * 25) skidMarks.push({ x: car.x, y: car.y, life: SKID_LIFE });
  } else {
    if (keys['KeyA']) car.angle -= turnBase * dt;
    if (keys['KeyD']) car.angle += turnBase * dt;
    if (dmg > 0.15) car.spinVel += (Math.random() - 0.5) * dmg * 5 * dt;
  }

  // P2 fire gun — ShiftLeft, ControlLeft, Tab, F, Q, Backquote (`), C
  const p2Firing = keys['ShiftLeft'] || keys['ControlLeft'] || keys['Tab'] ||
                   keys['KeyF'] || keys['KeyQ'] || keys['Backquote'] || keys['KeyC'];
  tryFire(car, p2Firing, dt);
  // P2 oil — E, Digit1 (1), V
  tryOil(car, keys['KeyE'] || keys['Digit1'] || keys['KeyV'], dt);
  updateBullets(car.bullets, dt);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  bounceOnWalls(car);
  emitSmoke(car, dt);

  if (car.hitFlash > 0 && Math.random() < dt * 20) skidMarks.push({ x: car.x, y: car.y, life: SKID_LIFE });

  const sector = getSector(car.x, car.y);
  if (sector !== car.prevSector && sector === car.nextSector) {
    car.sectorsPassed++;
    car.lap = Math.floor(car.sectorsPassed / 4);
    car.nextSector = (car.nextSector + 1) % 4;
    if (car.lap >= TOTAL_LAPS && !car.finished) {
      car.finished = true;
      car.finishTime = (performance.now() - raceStartTime) / 1000;
      finishOrder.push({ peerId: myP2PeerId, time: car.finishTime });
      broadcast({ type: 'finished', peerId: myP2PeerId, time: car.finishTime });
      checkAllFinished();
    }
  }
  car.prevSector = sector;
}

// ============================================================
// WEAPONS & COLLISIONS
// ============================================================
function applyHit(car) {
  if (car.hitCooldown > 0) return;
  car.hitCooldown = HIT_COOLDOWN;
  car.spinVel += (Math.random() < 0.5 ? 1 : -1) * HIT_SPIN;
  car.spinVel = Math.max(-6, Math.min(6, car.spinVel));
  car.speed *= HIT_SPEED_MULT;
  car.hitFlash = HIT_FLASH_DUR;
  applyPlayerDamage(car, DAMAGE_PER_BULLET);
}
function applyPlayerDamage(car, amount) {
  car.damage = Math.min(1.0, car.damage + amount);
}
function applyHitAI(car, net) {
  if (car.hitCooldown > 0 || car.exploded) return;
  const idx = aiCars.indexOf(car), spinDir = Math.random() < 0.5 ? 1 : -1;
  car.hitCooldown = HIT_COOLDOWN; car.swerveTimer = AI_SWERVE_DURATION;
  car.hitFlash = HIT_FLASH_DUR; car.spinVel += spinDir * HIT_SPIN * 2;
  if (net && idx >= 0) broadcast({ type: 'ai-swerve', idx, spinDir });
}
function explodeAI(car, net) {
  if (car.exploded) return;
  const idx = aiCars.indexOf(car);
  car.exploded = true; car.finished = true; car.speed = 0; car.swerveTimer = 0; car.explodeTimer = 0.7;
  if (net && idx >= 0) broadcast({ type: 'ai-explode', idx });
}
function checkBulletsVsAI(bullets) {
  for (const ai of aiCars) {
    if (ai.exploded) continue;
    for (const b of bullets) {
      const dx = b.x - ai.x, dy = b.y - ai.y;
      if (dx*dx + dy*dy < HIT_RADIUS*HIT_RADIUS) { applyHitAI(ai, true); break; }
    }
  }
}
function consumeCharge(charges) {
  const i = charges.findIndex(t => t === 0);
  if (i < 0) return false;
  charges[i] = RECHARGE_TIME; return true;
}
function updateCharges(charges, dt) {
  for (let i = 0; i < charges.length; i++) if (charges[i] > 0) charges[i] = Math.max(0, charges[i] - dt);
}

// ---- Laser helpers ----
function buildLaserBeams(car) {
  const lvl = car.laserLevel;
  const angles = lvl === 1 ? [car.angle]
    : lvl === 2 ? [car.angle - 0.14, car.angle + 0.14]
    : [car.angle - 0.24, car.angle, car.angle + 0.24];
  const ox = car.x + Math.cos(car.angle) * (CAR_L / 2 + 3);
  const oy = car.y + Math.sin(car.angle) * (CAR_L / 2 + 3);
  return angles.map(a => ({
    x1: ox, y1: oy,
    x2: ox + Math.cos(a) * 1100,
    y2: oy + Math.sin(a) * 1100,
  }));
}
function applyLaserHits(shooter, beams) {
  for (const b of beams) {
    const dx = b.x2 - b.x1, dy = b.y2 - b.y1;
    const bLen = Math.sqrt(dx*dx + dy*dy);
    const ux = dx/bLen, uy = dy/bLen;
    for (const ai of aiCars) {
      if (ai.exploded) continue;
      const tx = ai.x - b.x1, ty = ai.y - b.y1;
      const proj = tx*ux + ty*uy;
      if (proj < 0 || proj > bLen) continue;
      if (Math.abs(tx*uy - ty*ux) < HIT_RADIUS * 1.8) applyHitAI(ai, true);
    }
    for (const car of [myCar, myCarP2].filter(c => c && c !== shooter && !c.finished)) {
      const tx = car.x - b.x1, ty = car.y - b.y1;
      const proj = tx*ux + ty*uy;
      if (proj < 0 || proj > bLen) continue;
      if (Math.abs(tx*uy - ty*ux) < HIT_RADIUS * 1.5) applyHit(car);
    }
  }
}

function tryFire(car, firing, dt) {
  if (car.gunCharges) updateCharges(car.gunCharges, dt);
  car.fireTimer = Math.max(0, car.fireTimer - dt);
  car.laserBeams = null;

  if (!firing || car.finished) return;
  const hasCharge = car.gunCharges && car.gunCharges.some(c => c === 0);
  if (!hasCharge) return;

  if (car.laserLevel > 0) {
    // Laser mode — beam visible every frame key is held, hits applied per FIRE_RATE
    car.laserBeams = buildLaserBeams(car);
    if (car.fireTimer > 0) return;
    if (!consumeCharge(car.gunCharges)) return;
    car.fireTimer = FIRE_RATE;
    applyLaserHits(car, car.laserBeams);
  } else {
    // Bullet mode
    if (car.fireTimer > 0) return;
    if (!consumeCharge(car.gunCharges)) return;
    car.fireTimer = FIRE_RATE;
    const bvx = Math.cos(car.angle) * (BULLET_SPEED + Math.abs(car.speed));
    const bvy = Math.sin(car.angle) * (BULLET_SPEED + Math.abs(car.speed));
    car.bullets.push({
      x: car.x + Math.cos(car.angle) * (CAR_L / 2 + 5),
      y: car.y + Math.sin(car.angle) * (CAR_L / 2 + 5),
      vx: bvx, vy: bvy, life: BULLET_LIFE
    });
  }
}

function tryOil(car, firing, dt) {
  if (car.oilCharges) updateCharges(car.oilCharges, dt);
  car.oilFireTimer = Math.max(0, car.oilFireTimer - dt);
  if (!firing || car.finished || car.oilFireTimer > 0) return;
  if (!consumeCharge(car.oilCharges)) return;
  car.oilFireTimer = OIL_FIRE_RATE;
  const upgraded = car.oilUpgraded > 0;
  const drops = upgraded ? 3 : 1;
  const big = upgraded;
  for (let d = 0; d < drops; d++) {
    const sOff = drops === 1 ? 0 : (d - 1) * 0.32;
    const dist = CAR_L / 2 + 8 + (drops > 1 ? d * 6 : 0);
    const bx = car.x - Math.cos(car.angle + sOff) * dist;
    const by = car.y - Math.sin(car.angle + sOff) * dist;
    placeOilSlick(bx, by, car.angle, big, true);
  }
}
function placeOilSlick(x, y, angle, big, net) {
  const radius = big ? OIL_RADIUS * 1.8 : OIL_RADIUS;
  oilSlicks.push({ x, y, life: OIL_LIFE, angle, radius });
  if (net) broadcast({ type: 'oil-place', x: Math.round(x), y: Math.round(y), angle, big: big || false });
}
function checkOilSlicks(dt) {
  for (let i = oilSlicks.length - 1; i >= 0; i--) {
    const o = oilSlicks[i];
    o.life -= dt;
    if (o.life <= 0) { oilSlicks.splice(i, 1); continue; }
    const r = o.radius || OIL_RADIUS;
    const rSq = r * r;
    for (const ai of aiCars) {
      if (ai.exploded) continue;
      const dx = ai.x - o.x, dy = ai.y - o.y;
      if (dx*dx + dy*dy < rSq) { ai.swerveTimer = Math.max(ai.swerveTimer, OIL_SKID_DURATION); ai.hitFlash = Math.max(ai.hitFlash, 0.2); }
    }
    if (myCar && !myCar.finished) {
      const dx = myCar.x - o.x, dy = myCar.y - o.y;
      if (dx*dx + dy*dy < rSq) { myCar.skidTimer = Math.max(myCar.skidTimer, OIL_SKID_DURATION); myCar.hitFlash = Math.max(myCar.hitFlash, 0.2); }
    }
    if (myCarP2 && !myCarP2.finished) {
      const dx = myCarP2.x - o.x, dy = myCarP2.y - o.y;
      if (dx*dx + dy*dy < rSq) { myCarP2.skidTimer = Math.max(myCarP2.skidTimer, OIL_SKID_DURATION); myCarP2.hitFlash = Math.max(myCarP2.hitFlash, 0.2); }
    }
  }
}
function updateBullets(bullets, dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i]; b.x += b.vx*dt; b.y += b.vy*dt; b.life -= dt;
    if (b.life <= 0) bullets.splice(i, 1);
  }
}
function checkRemoteHits(localCar) {
  for (const remCar of remoteCars.values()) {
    if (!remCar.bullets) continue;
    for (const [bx, by] of remCar.bullets) {
      const dx = bx - localCar.x, dy = by - localCar.y;
      if (dx*dx + dy*dy < HIT_RADIUS*HIT_RADIUS) { applyHit(localCar); return; }
    }
  }
}
function checkLocalBulletHits(shooterBullets, targetCar) {
  for (const b of shooterBullets) {
    const dx = b.x - targetCar.x, dy = b.y - targetCar.y;
    if (dx*dx + dy*dy < HIT_RADIUS*HIT_RADIUS) { applyHit(targetCar); return; }
  }
}
function collideCars(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, distSq = dx*dx + dy*dy, minDist = CAR_RADIUS*2;
  if (distSq >= minDist*minDist || distSq < 0.01) return false;
  const dist = Math.sqrt(distSq), nx = dx/dist, ny = dy/dist, push = (minDist-dist)*0.5;
  a.x += nx*push; a.y += ny*push; b.x -= nx*push; b.y -= ny*push;
  let avx = Math.cos(a.angle)*a.speed, avy = Math.sin(a.angle)*a.speed;
  let bvx = Math.cos(b.angle)*b.speed, bvy = Math.sin(b.angle)*b.speed;
  const relVel = (avx-bvx)*nx + (avy-bvy)*ny;
  if (relVel >= 0) return true;
  const impulse = -(1+CAR_BOUNCE)*relVel*0.5;
  avx += impulse*nx; avy += impulse*ny; bvx -= impulse*nx; bvy -= impulse*ny;
  a.speed = Math.min(Math.sqrt(avx*avx+avy*avy), MAX_SPEED*1.3);
  b.speed = Math.min(Math.sqrt(bvx*bvx+bvy*bvy), MAX_SPEED*1.3);
  if (a.speed > 1) a.angle = Math.atan2(avy, avx);
  if (b.speed > 1) b.angle = Math.atan2(bvy, bvx);
  a.spinVel += (Math.random()-0.5)*3; b.spinVel += (Math.random()-0.5)*3;
  return true;
}
function collideCarOneWay(mine, other) {
  const dx = mine.x-other.x, dy = mine.y-other.y, distSq = dx*dx+dy*dy, minDist = CAR_RADIUS*2;
  if (distSq >= minDist*minDist || distSq < 0.01) return;
  const dist = Math.sqrt(distSq), nx = dx/dist, ny = dy/dist;
  mine.x = other.x + nx*minDist; mine.y = other.y + ny*minDist;
  let vx = Math.cos(mine.angle)*mine.speed, vy = Math.sin(mine.angle)*mine.speed;
  const dot = vx*nx + vy*ny;
  if (dot < 0) { vx -= 2*dot*nx; vy -= 2*dot*ny; vx *= CAR_BOUNCE; vy *= CAR_BOUNCE; mine.speed = Math.min(Math.sqrt(vx*vx+vy*vy), MAX_SPEED*1.3); if (mine.speed > 1) mine.angle = Math.atan2(vy, vx); mine.spinVel += (Math.random()-0.5)*3; }
}

// ============================================================
// SMOKE PARTICLES
// ============================================================
function emitSmoke(car, dt) {
  const dmg = car.damage;
  if (dmg < 0.1) return;
  const rate = ((dmg - 0.1) / 0.9) * 45;
  const n = Math.floor(rate * dt + Math.random());
  for (let i = 0; i < n; i++) {
    const ml = 0.5 + Math.random() * 0.8;
    smokeParticles.push({
      x: car.x - Math.cos(car.angle) * (CAR_L/2) + (Math.random()-0.5)*5,
      y: car.y - Math.sin(car.angle) * (CAR_L/2) + (Math.random()-0.5)*5,
      vx: -Math.cos(car.angle)*car.speed*0.08 + (Math.random()-0.5)*18,
      vy: -Math.sin(car.angle)*car.speed*0.08 + (Math.random()-0.5)*18,
      life: ml, maxLife: ml, r: 3 + dmg * 6,
    });
  }
}
function updateSmoke(dt) {
  for (let i = smokeParticles.length - 1; i >= 0; i--) {
    const p = smokeParticles[i];
    p.x += p.vx*dt; p.y += p.vy*dt;
    p.vx *= (1 - 2*dt); p.vy *= (1 - 2*dt);
    p.life -= dt;
    if (p.life <= 0) smokeParticles.splice(i, 1);
  }
}
function drawSmoke() {
  for (const p of smokeParticles) {
    const age = 1 - p.life / p.maxLife;
    ctx.globalAlpha = (1 - age) * 0.48;
    const g = Math.floor(70 + age * 90);
    ctx.fillStyle = `rgb(${g},${g},${g})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * (1 + age * 1.2), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ============================================================
// WALKERS (wrenches & power-ups)
// ============================================================
function spawnWalker() {
  const fromTop = Math.random() < 0.5;
  // Spread across track x range; walkers walk top↔bottom crossing the road
  const x = 130 + Math.random() * 760;
  const types = ['wrench', 'wrench', 'laser', 'oil']; // wrench more common
  walkers.push({
    x, y: fromTop ? -28 : GH + 28,
    vy: fromTop ? WALKER_SPEED : -WALKER_SPEED,
    type: types[Math.floor(Math.random() * types.length)],
    legPhase: Math.random() * Math.PI * 2,
    flare: 0, dead: false,
  });
}

function updateWalkers(dt) {
  walkerSpawnTimer -= dt;
  if (walkerSpawnTimer <= 0 && raceGo) {
    walkerSpawnTimer = 5 + Math.random() * 9;
    spawnWalker();
    if (Math.random() < 0.4) spawnWalker(); // occasionally spawn a pair
  }

  const playerCars = [myCar, myCarP2].filter(Boolean);
  const allMovingCars = [
    ...playerCars,
    ...aiCars.filter(a => !a.exploded),
    ...remoteCars.values(),
  ].filter(Boolean);

  for (let i = walkers.length - 1; i >= 0; i--) {
    const w = walkers[i];

    if (w.dead) {
      w.flare -= dt;
      if (w.flare <= 0) walkers.splice(i, 1);
      continue;
    }

    w.y += w.vy * dt;
    w.legPhase += 6 * dt;

    // Dodge nearby cars — AI: good dodge (big radius), players: poor dodge (small radius)
    let dxDodge = 0;
    for (const car of allMovingCars) {
      const isPlayer = playerCars.includes(car);
      const detectR = isPlayer ? 28 : 88;
      const cdx = w.x - car.x, cdy = w.y - car.y;
      const dist = Math.sqrt(cdx*cdx + cdy*cdy);
      if (dist < detectR && dist > 0.5) {
        const strength = isPlayer ? 35 : 130;
        dxDodge += (cdx / dist) * (1 - dist / detectR) * strength;
      }
    }
    w.x = Math.max(55, Math.min(GW - 55, w.x + dxDodge * dt));

    // Hit detection — any car
    for (const car of allMovingCars) {
      const cdx = w.x - car.x, cdy = w.y - car.y;
      if (cdx*cdx + cdy*cdy < WALKER_HIT_R * WALKER_HIT_R) {
        if (playerCars.includes(car)) applyWalkerEffect(car, w.type);
        w.dead = true;
        w.flare = WALKER_FLARE;
        break;
      }
    }

    if (w.y < -65 || w.y > GH + 65) walkers.splice(i, 1);
  }
}

function applyWalkerEffect(car, type) {
  if (type === 'wrench') {
    car.damage = car.damage / 3; // reduce damage by 2/3
  } else if (type === 'laser') {
    car.laserLevel = Math.min(3, car.laserLevel + 1);
  } else if (type === 'oil') {
    car.oilUpgraded = Math.min(3, car.oilUpgraded + 1);
  }
}

function drawWalkerFigure(ctx, type, legPhase) {
  // Legs — two rectangles swinging opposite phases
  const swing = Math.sin(legPhase) * 7;
  ctx.fillStyle = '#c8a050';
  // Left leg (forward)
  ctx.save(); ctx.translate(-3, 4); ctx.rotate(swing * 0.04);
  ctx.fillRect(-2, 0, 4, 11); ctx.restore();
  // Right leg (backward)
  ctx.save(); ctx.translate(3, 4); ctx.rotate(-swing * 0.04);
  ctx.fillRect(-2, 0, 4, 11); ctx.restore();

  // Icon body above (everything IS the icon)
  if (type === 'wrench') {
    ctx.fillStyle = '#d0d0d0'; // silver
    ctx.fillRect(-2, -16, 4, 18); // handle
    // Top jaw
    ctx.beginPath();
    ctx.arc(0, -16, 6, 0, Math.PI * 2);
    ctx.fill();
    // Jaw opening (dark notch)
    ctx.fillStyle = '#2a5a1a';
    ctx.fillRect(-5, -20, 3, 6);
    ctx.fillRect(2, -20, 3, 6);
    // Bottom knob
    ctx.fillStyle = '#d0d0d0';
    ctx.beginPath();
    ctx.arc(0, 2, 3.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'laser') {
    ctx.fillStyle = '#00ccff'; // cyan body
    ctx.fillRect(-4, -15, 8, 17);
    ctx.fillRect(-2, -21, 4, 7); // barrel
    // Energy crystal (red tip)
    ctx.fillStyle = '#ff3300';
    ctx.beginPath();
    ctx.arc(0, -21, 3.5, 0, Math.PI * 2);
    ctx.fill();
    // Glow ring
    ctx.strokeStyle = '#88eeff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, -21, 5.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    // LVL hint
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 5px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('LZR', 0, -5);
  } else { // oil
    ctx.fillStyle = '#111122'; // dark barrel
    ctx.beginPath();
    ctx.ellipse(0, -9, 7, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222244';
    ctx.fillRect(-7, -13, 14, 3);
    ctx.fillRect(-7, -7, 14, 3);
    // Valve on top
    ctx.fillStyle = '#888';
    ctx.fillRect(-1, -21, 2, 10);
    ctx.beginPath();
    ctx.arc(0, -21, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawWalkers() {
  for (const w of walkers) {
    if (w.dead) {
      // Expanding flare
      const t = Math.max(0, w.flare / WALKER_FLARE);
      const r = (1 - t) * 38 + 6;
      ctx.globalAlpha = t * 0.92;
      ctx.fillStyle = '#ffee33';
      ctx.beginPath(); ctx.arc(w.x, w.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff8800';
      ctx.beginPath(); ctx.arc(w.x, w.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
      // Sparkles
      ctx.fillStyle = '#fff';
      for (let s = 0; s < 6; s++) {
        const sa = (s / 6) * Math.PI * 2 + (1 - t) * 5;
        ctx.beginPath();
        ctx.arc(w.x + Math.cos(sa) * r * 0.82, w.y + Math.sin(sa) * r * 0.82, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      continue;
    }

    ctx.save();
    ctx.translate(w.x, w.y);
    drawWalkerFigure(ctx, w.type, w.legPhase);
    ctx.restore();
    ctx.textAlign = 'center'; // reset after any text in drawWalkerFigure
  }
}

// ============================================================
// LASER BEAM RENDERING
// ============================================================
function drawLaserBeams(beams, level, color) {
  if (!beams || !beams.length) return;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 + level * 1.2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  for (const b of beams) {
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
  }
  // Bright core
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.8;
  ctx.shadowBlur = 0;
  for (const b of beams) {
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
  }
  ctx.restore();
}

// ============================================================
// RENDERING — TRACK
// ============================================================
function drawTrack() {
  function dPath(lx, ty, by, r) {
    const cy = (ty + by) / 2, rr = (by - ty) / 2;
    ctx.beginPath();
    ctx.moveTo(lx + r, ty);
    ctx.lineTo(SC_X, ty);
    ctx.arc(SC_X, cy, rr, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(lx + r, by);
    ctx.arc(lx + r, by - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(lx, ty + r);
    ctx.arc(lx + r, ty + r, r, Math.PI, 3 * Math.PI / 2);
    ctx.closePath();
  }
  ctx.fillStyle = '#1e4d0f'; ctx.fillRect(0, 0, GW, GH);
  dPath(TCX-O_HW-12, TCY-O_HH-12, TCY+O_HH+12, O_R+12);
  ctx.fillStyle = '#3a3a3a'; ctx.fill();
  dPath(TCX-I_HW+12, TCY-I_HH+12, TCY+I_HH-12, I_R-12);
  ctx.fillStyle = '#1e4d0f'; ctx.fill();
  ctx.strokeStyle = '#ddd'; ctx.lineWidth = 5;
  dPath(TCX-O_HW-10, TCY-O_HH-10, TCY+O_HH+10, O_R+10); ctx.stroke();
  dPath(TCX-I_HW+10, TCY-I_HH+10, TCY+I_HH-10, I_R-10); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2; ctx.setLineDash([24, 24]);
  dPath((TCX-O_HW+TCX-I_HW)/2, (TCY-O_HH+TCY-I_HH)/2, (TCY+O_HH+TCY+I_HH)/2, (O_R+I_R)/2);
  ctx.stroke(); ctx.setLineDash([]);
  const sfX = SC_X - 30, sfY1 = TCY-O_HH-2, sfY2 = TCY-I_HH+2, sqH = 12, sqW = 10;
  const rows = Math.floor((sfY2 - sfY1) / sqH);
  for (let j = 0; j < rows; j++) {
    ctx.fillStyle = (j % 2 === 0) ? '#fff' : '#111';
    ctx.fillRect(sfX - sqW/2, sfY1 + j*sqH, sqW, sqH);
  }
}

// ============================================================
// RENDERING — CARS
// ============================================================
function drawCar(car, label, isMe) {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-CAR_L/2+3, -CAR_W/2+3, CAR_L, CAR_W);
  ctx.fillStyle = car.color;
  ctx.fillRect(-CAR_L/2, -CAR_W/2, CAR_L, CAR_W);
  ctx.fillStyle = 'rgba(180,230,255,0.65)';
  ctx.fillRect(1, -CAR_W/2+2, CAR_L/2-2, CAR_W-4);
  ctx.fillStyle = '#ffff99';
  ctx.fillRect(CAR_L/2-4, -CAR_W/2+2, 4, 3);
  ctx.fillRect(CAR_L/2-4, CAR_W/2-5, 4, 3);
  ctx.fillStyle = '#ff4444';
  ctx.fillRect(-CAR_L/2, -CAR_W/2+2, 3, 3);
  ctx.fillRect(-CAR_L/2, CAR_W/2-5, 3, 3);
  if ((car.damage || 0) > 0) {
    ctx.fillStyle = `rgba(0,0,0,${car.damage * 0.45})`;
    ctx.fillRect(-CAR_L/2, -CAR_W/2, CAR_L, CAR_W);
  }
  if (car.hitFlash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, car.hitFlash / HIT_FLASH_DUR) * 0.7})`;
    ctx.fillRect(-CAR_L/2, -CAR_W/2, CAR_L, CAR_W);
  }
  ctx.restore();
  ctx.textAlign = 'center';
  ctx.font = isMe ? 'bold 11px monospace' : '10px monospace';
  ctx.fillStyle = isMe ? '#fff' : 'rgba(255,255,255,0.7)';
  ctx.fillText(label, car.x, car.y - 20);
}
function drawBullets(bullets, color) {
  if (!bullets || !bullets.length) return;
  ctx.fillStyle = color;
  for (const b of bullets) {
    ctx.globalAlpha = Math.min(1, b.life * 3);
    ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - b.vx*0.018, b.y - b.vy*0.018); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function drawSkidMarks() {
  for (const s of skidMarks) {
    ctx.globalAlpha = (s.life / SKID_LIFE) * 0.55;
    ctx.fillStyle = '#777';
    ctx.beginPath(); ctx.arc(s.x, s.y, 3, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawOilSlicks() {
  for (const o of oilSlicks) {
    const r = o.radius || OIL_RADIUS;
    const fade = o.life / OIL_LIFE;
    ctx.globalAlpha = Math.min(fade * 3, 1) * 0.88;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle || 0);
    ctx.fillStyle = '#050505';
    ctx.fillRect(-r * 0.9, -r * 0.45, r * 1.8, r * 0.9);
    ctx.fillStyle = 'rgba(20,20,50,0.55)';
    ctx.fillRect(-r * 0.65, -r * 0.3, r * 1.3, r * 0.6);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}
function drawAmmoRow(charges, bx, by, bw, bh, readyColor) {
  const segW = bw / MAX_CHARGES;
  for (let i = 0; i < MAX_CHARGES; i++) {
    ctx.fillStyle = charges[i] === 0 ? readyColor : '#252525';
    ctx.fillRect(bx + i*segW + 1, by, segW - 2, bh);
  }
}

// ============================================================
// RENDERING — LOBBY
// ============================================================
function drawLobby(dt) {
  ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'left'; ctx.fillStyle = '#444'; ctx.font = '12px monospace';
  ctx.fillText('v' + VERSION, 10, 18);
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff'; ctx.font = 'bold 80px monospace';
  ctx.fillText('GRAND PRIX', GW/2, 110);
  ctx.fillStyle = '#777'; ctx.font = '18px monospace';
  ctx.fillText('share this page to invite friends  •  up to 8 players', GW/2, 148);
  ctx.fillStyle = '#555'; ctx.font = '14px monospace';
  ctx.fillText(window.location.href, GW/2, 174);

  const slotW = 128, slotH = 110, gap = 14;
  const totalW = MAX_SLOTS*slotW + (MAX_SLOTS-1)*gap;
  const sx0 = GW/2 - totalW/2, sy0 = 210;
  for (let i = 0; i < MAX_SLOTS; i++) {
    const sx = sx0 + i*(slotW+gap), s = slots[i], col = SLOT_COLORS[i];
    ctx.fillStyle = s.peerId ? col+'22' : '#181818';
    ctx.strokeStyle = s.peerId ? col : '#333';
    ctx.lineWidth = s.peerId === myPeerId ? 3 : 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(sx, sy0, slotW, slotH, 8); else ctx.rect(sx, sy0, slotW, slotH);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx+slotW/2, sy0+26, 20, 0, 2*Math.PI);
    ctx.fillStyle = s.peerId ? col : '#333'; ctx.fill();
    if (s.peerId) {
      ctx.save(); ctx.translate(sx+slotW/2, sy0+26);
      ctx.fillStyle = '#000'; ctx.fillRect(-9,-4,18,8);
      ctx.fillStyle = col; ctx.fillRect(-8,-3,16,6); ctx.restore();
    }
    ctx.textAlign = 'center';
    if (s.ready) {
      ctx.fillStyle = '#44ff88'; ctx.font = 'bold 14px monospace'; ctx.fillText('READY!', sx+slotW/2, sy0+66);
    } else if (s.holding) {
      ctx.fillStyle = '#282828'; ctx.fillRect(sx+12, sy0+60, slotW-24, 10);
      ctx.fillStyle = col; ctx.fillRect(sx+12, sy0+60, (slotW-24)*s.progress/100, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '10px monospace'; ctx.fillText('HOLD...', sx+slotW/2, sy0+58);
    } else if (s.peerId) {
      const label = s.peerId === myPeerId ? '← P1' : s.peerId === myP2PeerId ? '← P2' : 'joined';
      ctx.fillStyle = (s.peerId===myPeerId||s.peerId===myP2PeerId) ? '#aaa' : '#555';
      ctx.font = '11px monospace'; ctx.fillText(label, sx+slotW/2, sy0+68);
    } else {
      ctx.fillStyle = '#333'; ctx.font = '12px monospace'; ctx.fillText('OPEN', sx+slotW/2, sy0+72);
    }
  }

  ctx.textAlign = 'center';
  const inY = sy0 + slotH + 34;
  if (mySlotIndex < 0) {
    ctx.fillStyle = '#eee'; ctx.font = 'bold 24px monospace';
    ctx.fillText('↑ or SPACE = join as P1  •  W = join as P2', GW/2, inY);
  } else if (!slots[mySlotIndex]?.ready) {
    ctx.fillStyle = '#eee'; ctx.font = 'bold 24px monospace';
    ctx.fillText('Hold ↑ / SPACE to ready (P1)' + (myP2SlotIndex >= 0 ? '  •  Hold W (P2)' : '  •  W = add P2'), GW/2, inY);
    ctx.fillStyle = '#555'; ctx.font = '15px monospace'; ctx.fillText('release to cancel', GW/2, inY+28);
  } else {
    ctx.fillStyle = '#44ff88'; ctx.font = 'bold 24px monospace'; ctx.fillText('Waiting for race to start...', GW/2, inY);
  }
  ctx.fillStyle = '#444'; ctx.font = '15px monospace';
  ctx.fillText('P1: ↑↓←→  •  P2: WASD  •  Race ' + TOTAL_LAPS + ' laps clockwise', GW/2, inY+60);

  if (lobbyState === 'countdown') {
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(0,0,GW,GH);
    ctx.fillStyle = '#ffe030'; ctx.font = 'bold 140px monospace'; ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(countdownTimer), GW/2, GH/2+50);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 40px monospace'; ctx.fillText('GET READY!', GW/2, GH/2-50);
  }
}

// ============================================================
// RENDERING — HUD
// ============================================================
function drawHUD() {
  const allCars = [
    ...remoteCars.values(),
    ...(myCar   ? [{ sectorsPassed: myCar.sectorsPassed,   peerId: myPeerId   }] : []),
    ...(myCarP2 ? [{ sectorsPassed: myCarP2.sectorsPassed, peerId: myP2PeerId }] : []),
  ];
  allCars.sort((a, b) => (b.sectorsPassed ?? 0) - (a.sectorsPassed ?? 0));

  function ordinal(n) { return n + (['st','nd','rd'][n-1] || 'th'); }

  function drawPlayerBox(car, peerId, label, alignRight) {
    const W = 200, H = 125;
    const x = alignRight ? GW - W - 12 : 12;
    const y = 12;
    ctx.fillStyle = 'rgba(0,0,0,0.68)'; ctx.fillRect(x, y, W, H);
    ctx.fillStyle = car.color;
    ctx.fillRect(alignRight ? x : x + W - 5, y, 5, H);

    const pos = allCars.findIndex(c => c.peerId === peerId) + 1;
    const lap = Math.min(car.lap + 1, TOTAL_LAPS);
    ctx.textAlign = alignRight ? 'right' : 'left';
    const tx = alignRight ? x + W - 10 : x + 10;

    ctx.fillStyle = '#888'; ctx.font = '11px monospace'; ctx.fillText(label, tx, y+16);

    // Dynamic hints: show upgrade status
    const gunHint = car.laserLevel > 0 ? `LZR×${car.laserLevel}` : (alignRight ? 'Q`C' : '/,[');
    const oilHint = car.oilUpgraded > 0 ? `OIL+${car.oilUpgraded}` : (alignRight ? 'E1V' : '.↵]');
    ctx.fillStyle = car.laserLevel > 0 ? '#00ccff' : '#555';
    ctx.font = '9px monospace'; ctx.fillText('gun:' + gunHint + '  oil:' + oilHint, tx, y+29);

    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px monospace'; ctx.fillText('LAP '+lap+' / '+TOTAL_LAPS, tx, y+50);
    ctx.fillStyle = '#aaa'; ctx.font = '12px monospace'; ctx.fillText(Math.round(Math.abs(car.speed))+' px/s', tx, y+65);
    ctx.fillStyle = pos===1 ? '#ffe030' : '#ccc'; ctx.font = 'bold 18px monospace'; ctx.fillText(ordinal(pos), tx, y+83);

    const barsX = x + 7, barsW = W - 14;
    if (car.gunCharges) drawAmmoRow(car.gunCharges, barsX, y+89, barsW, 7, car.laserLevel > 0 ? '#00ccff' : '#ff7700');
    if (car.oilCharges) drawAmmoRow(car.oilCharges, barsX, y+100, barsW, 7, '#22aa44');
    // Damage bar
    ctx.fillStyle = '#1a0000'; ctx.fillRect(barsX, y+111, barsW, 7);
    if (car.damage > 0) {
      ctx.fillStyle = car.damage < 0.5 ? '#dd6600' : '#cc2200';
      ctx.fillRect(barsX, y+111, barsW * car.damage, 7);
    }
  }

  if (myCar)   drawPlayerBox(myCar,   myPeerId,   'P1 ↑↓←→', false);
  if (myCarP2) drawPlayerBox(myCarP2, myP2PeerId, 'P2 WASD',  true);

  const elapsed = (performance.now() - raceStartTime) / 1000;
  const mins = Math.floor(elapsed / 60);
  const secs = (elapsed % 60).toFixed(1).padStart(4, '0');
  ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(GW/2-76, 12, 152, 42);
  ctx.fillStyle = '#ddd'; ctx.font = 'bold 20px monospace'; ctx.textAlign = 'center';
  ctx.fillText(mins + ':' + secs, GW/2, 38);

  if (elapsed < 3.0) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0,0,GW,GH);
    ctx.fillStyle = '#ffe030'; ctx.font = 'bold 180px monospace'; ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(3.0 - elapsed), GW/2, GH/2+60);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 36px monospace'; ctx.fillText('RACE IN...', GW/2, GH/2-60);
  } else if (goFlashTimer > 0) {
    const alpha = Math.min(1, goFlashTimer);
    ctx.fillStyle = 'rgba(0,0,0,' + (alpha*0.4) + ')'; ctx.fillRect(0,0,GW,GH);
    ctx.globalAlpha = alpha; ctx.fillStyle = '#44ff88'; ctx.font = 'bold 200px monospace';
    ctx.textAlign = 'center'; ctx.fillText('GO!', GW/2, GH/2+60); ctx.globalAlpha = 1;
  }
}

// ============================================================
// RENDERING — FINISH
// ============================================================
function drawFinish() {
  drawTrack();
  for (const [pid, car] of remoteCars) { if (car) drawCar(car, pid.slice(0,5), false); }
  if (myCarP2) drawCar(myCarP2, 'P2', false);
  if (myCar)   drawCar(myCar, 'P1', true);
  ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(0,0,GW,GH);
  const bw = 460, bh = 80 + finishOrder.length*50 + 60;
  const bx = GW/2 - bw/2, by = GH/2 - bh/2;
  ctx.fillStyle = '#141414'; ctx.strokeStyle = '#ffe030'; ctx.lineWidth = 3;
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 12); else ctx.rect(bx, by, bw, bh);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#ffe030'; ctx.font = 'bold 42px monospace'; ctx.textAlign = 'center';
  ctx.fillText('RACE OVER!', GW/2, by+54);
  finishOrder.forEach((f, i) => {
    const rowY = by + 100 + i*50;
    const mins = Math.floor(f.time/60);
    const secs = (f.time%60).toFixed(2).padStart(5,'0');
    const name = f.peerId===myPeerId ? 'P1(you)' : f.peerId===myP2PeerId ? 'P2(you)' : f.peerId.slice(0,7);
    ctx.fillStyle = i===0 ? '#ffe030' : '#ccc'; ctx.font = 'bold 22px monospace'; ctx.textAlign = 'center';
    ctx.fillText((i+1)+'.  '+name.padEnd(8)+'  '+mins+':'+secs, GW/2, rowY);
  });
  ctx.fillStyle = '#555'; ctx.font = '16px monospace'; ctx.fillText('refresh to play again', GW/2, by+bh-18);
}

// ============================================================
// AI CARS
// ============================================================
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI*2;
  while (d < -Math.PI) d += Math.PI*2;
  return a + d*t;
}
function getTrackTangent(px, py, cw) {
  const {nx, ny} = innerNormal(px, py);
  return cw ? {tx: -ny, ty: nx} : {tx: ny, ty: -nx};
}

const AI_STARTS = [
  { x: 200, y: 130, a: 0 }, { x: 300, y: 130, a: 0 }, { x: 400, y: 130, a: 0 },
  { x: 500, y: 130, a: 0 }, { x: 600, y: 130, a: 0 }, { x: 700, y: 130, a: 0 },
  { x: 200, y: 215, a: 0 }, { x: 350, y: 215, a: 0 }, { x: 500, y: 215, a: 0 }, { x: 650, y: 215, a: 0 },
  { x: 1010, y: 187, a: Math.PI/6 }, { x: 1110, y: 360, a: Math.PI/2 },
  { x: 1010, y: 533, a: 5*Math.PI/6 }, { x: 1070, y: 250, a: Math.PI/3 }, { x: 1070, y: 470, a: 2*Math.PI/3 },
  { x: 800, y: 590, a: Math.PI }, { x: 700, y: 590, a: Math.PI }, { x: 600, y: 590, a: Math.PI },
  { x: 500, y: 590, a: Math.PI }, { x: 400, y: 590, a: Math.PI }, { x: 300, y: 590, a: Math.PI },
  { x: 800, y: 500, a: Math.PI }, { x: 650, y: 500, a: Math.PI }, { x: 500, y: 500, a: Math.PI }, { x: 350, y: 500, a: Math.PI },
  { x: 175, y: 560, a: -Math.PI/2 }, { x: 175, y: 460, a: -Math.PI/2 }, { x: 175, y: 360, a: -Math.PI/2 },
  { x: 255, y: 500, a: -Math.PI/2 }, { x: 255, y: 400, a: -Math.PI/2 },
];

function makeAICar(index) {
  const s = AI_STARTS[index % AI_STARTS.length];
  return {
    x: s.x, y: s.y, angle: s.a, speed: AI_SPEED * 0.6,
    cw: true, isAI: true, color: '#ffffff',
    laneTarget: index % 2 === 0 ? -50 : -130,
    spinVel: 0, hitFlash: 0, hitCooldown: 0,
    isAggro: false, aggroTarget: null,
    swerveTimer: 0, exploded: false, explodeTimer: 0,
    prevSector: getSector(s.x, s.y),
    nextSector: (getSector(s.x, s.y) + 1) % 4,
    sectorsPassed: 0, lap: 0, finished: false, finishTime: 0,
    slotIndex: -1, fireTimer: 0, bullets: [],
  };
}
function initAICars() {
  aiCars = [];
  for (let i = 0; i < AI_COUNT; i++) aiCars.push(makeAICar(i));
  aggroTimer = AI_AGGRO_INTERVAL; aggroCar = null;
}
function getLeadPlayer() {
  const players = [myCar, myCarP2, ...remoteCars.values()].filter(c => c && !c.finished);
  if (!players.length) return null;
  return players.reduce((b, c) => (c.lap*100+c.sectorsPassed) > (b.lap*100+b.sectorsPassed) ? c : b);
}
function updateAICar(car, dt) {
  if (car.exploded) { car.explodeTimer = Math.max(0, car.explodeTimer-dt); return; }
  if (!raceGo) return;
  car.hitCooldown = Math.max(0, car.hitCooldown-dt);
  car.hitFlash = Math.max(0, car.hitFlash-dt);
  car.spinVel *= Math.exp(-SPIN_DECAY*dt);
  car.angle += car.spinVel*dt;

  if (car.swerveTimer > 0) {
    car.swerveTimer -= dt;
    car.hitFlash = Math.max(car.hitFlash, 0.08);
    car.spinVel += (Math.random()-0.5)*22*dt;
    car.x += Math.cos(car.angle)*car.speed*dt;
    car.y += Math.sin(car.angle)*car.speed*dt;
    if (Math.random() < dt*20) skidMarks.push({ x: car.x, y: car.y, life: SKID_LIFE });
    if (bounceOnWalls(car)) explodeAI(car, true);
    return;
  }

  const {tx,ty} = getTrackTangent(car.x, car.y, car.cw);
  let desired = Math.atan2(ty, tx);
  if (car.isAggro && car.aggroTarget) {
    const t = car.aggroTarget, dx = t.x-car.x, dy = t.y-car.y, dist = Math.sqrt(dx*dx+dy*dy);
    if (dist > 30) desired = lerpAngle(desired, Math.atan2(dy, dx), Math.min(0.45, 120/dist));
  }
  const others = [myCar, myCarP2, ...remoteCars.values(), ...aiCars].filter(c => c && c !== car);
  let ax = 0, ay = 0;
  for (const o of others) {
    const dx = car.x-o.x, dy = car.y-o.y, d = Math.sqrt(dx*dx+dy*dy);
    if (d < AI_AVOID_RADIUS && d > 0.5) { const f = 1-d/AI_AVOID_RADIUS; ax += (dx/d)*f; ay += (dy/d)*f; }
  }
  const avoidMag = Math.sqrt(ax*ax+ay*ay);
  if (avoidMag > 0.05) desired = lerpAngle(desired, Math.atan2(ay, ax), Math.min(avoidMag*0.7, 0.6));
  const laneTarget = car.laneTarget ?? -50;
  const od = sdfOuter(car.x, car.y), laneErr = od - laneTarget;
  if (Math.abs(laneErr) > 8) {
    const {nx,ny} = outerNormal(car.x, car.y);
    desired = lerpAngle(desired, Math.atan2(-laneErr*ny, -laneErr*nx), 0.12);
  }
  let diff = desired - car.angle;
  while (diff > Math.PI) diff -= Math.PI*2; while (diff < -Math.PI) diff += Math.PI*2;
  car.angle += Math.sign(diff) * Math.min(Math.abs(diff)*4, AI_TURN_RATE) * dt;
  const topSpeed = car.isAggro ? AI_SPEED*1.15 : AI_SPEED;
  if (car.speed < topSpeed) car.speed = Math.min(car.speed+AI_ACCEL*dt, topSpeed);
  else car.speed *= Math.exp(-FRICTION_K*dt);
  car.x += Math.cos(car.angle)*car.speed*dt;
  car.y += Math.sin(car.angle)*car.speed*dt;
  bounceOnWalls(car);
  const sec = getSector(car.x, car.y);
  if (sec !== car.prevSector && sec === car.nextSector) {
    car.sectorsPassed++; car.lap = Math.floor(car.sectorsPassed/4); car.nextSector = (car.nextSector+1)%4;
  }
  car.prevSector = sec;
}
function updateAggroState(dt) {
  aggroTimer -= dt;
  if (aggroTimer <= 0) {
    aggroTimer = AI_AGGRO_INTERVAL;
    if (aggroCar) { aggroCar.isAggro = false; aggroCar.aggroTarget = null; }
    const alive = aiCars.filter(a => !a.exploded);
    aggroCar = alive.length ? alive[Math.floor(Math.random()*alive.length)] : null;
    if (aggroCar) { aggroCar.isAggro = true; aggroCar.aggroTarget = getLeadPlayer(); }
  }
  if (aggroCar && aggroCar.isAggro) aggroCar.aggroTarget = getLeadPlayer();
}

// ============================================================
// GAME LOOP
// ============================================================
let lastTime = 0;
function loop(ts) {
  const dt = Math.min((ts - (lastTime || ts)) / 1000, 0.05);
  lastTime = ts;
  if (goFlashTimer > 0) goFlashTimer -= dt;

  if (lobbyState === 'lobby' || lobbyState === 'countdown') {
    updateHold(dt); updateHoldP2(dt); updateCountdown(dt); drawLobby(dt);
  } else if (lobbyState === 'game') {
    if (myCar)   updateCar(myCar, dt);
    if (myCarP2) updateCarP2(myCarP2, dt);
    updateAggroState(dt);
    for (const ai of aiCars) updateAICar(ai, dt);
    updateWalkers(dt);

    // Car-to-car collisions
    if (myCar && myCarP2) collideCars(myCar, myCarP2);
    for (const remCar of remoteCars.values()) {
      if (myCar)   collideCarOneWay(myCar, remCar);
      if (myCarP2) collideCarOneWay(myCarP2, remCar);
    }
    for (const ai of aiCars) {
      if (ai.exploded) continue;
      if (myCar   && collideCars(myCar,   ai) && ai.swerveTimer > 0) explodeAI(ai, true);
      if (myCarP2 && collideCars(myCarP2, ai) && ai.swerveTimer > 0) explodeAI(ai, true);
    }
    for (let i = 0; i < aiCars.length; i++) {
      if (aiCars[i].exploded) continue;
      for (let j = i+1; j < aiCars.length; j++) {
        if (aiCars[j].exploded) continue;
        if (collideCars(aiCars[i], aiCars[j])) {
          if (aiCars[i].swerveTimer > 0) { explodeAI(aiCars[i], true); explodeAI(aiCars[j], true); }
          else if (aiCars[j].swerveTimer > 0) { explodeAI(aiCars[j], true); explodeAI(aiCars[i], true); }
        }
      }
    }

    // Bullet/laser hit detection
    if (myCar)   checkRemoteHits(myCar);
    if (myCarP2) checkRemoteHits(myCarP2);
    if (myCar && myCarP2) {
      checkLocalBulletHits(myCar.bullets, myCarP2);
      checkLocalBulletHits(myCarP2.bullets, myCar);
    }
    if (myCar)   checkBulletsVsAI(myCar.bullets);
    if (myCarP2) checkBulletsVsAI(myCarP2.bullets);

    // Effects aging
    checkOilSlicks(dt);
    updateSmoke(dt);
    for (let i = skidMarks.length-1; i >= 0; i--) {
      skidMarks[i].life -= dt;
      if (skidMarks[i].life <= 0) skidMarks.splice(i, 1);
    }

    // Broadcast
    if (myCar) broadcast({ type:'update', peerId:myPeerId, car:{
      x:myCar.x, y:myCar.y, angle:myCar.angle, speed:myCar.speed,
      sectorsPassed:myCar.sectorsPassed, lap:myCar.lap, finished:myCar.finished,
      color:myCar.color, slotIndex:myCar.slotIndex,
      bullets:myCar.bullets.map(b=>[Math.round(b.x),Math.round(b.y)])
    }});
    if (myCarP2) broadcast({ type:'update', peerId:myP2PeerId, car:{
      x:myCarP2.x, y:myCarP2.y, angle:myCarP2.angle, speed:myCarP2.speed,
      sectorsPassed:myCarP2.sectorsPassed, lap:myCarP2.lap, finished:myCarP2.finished,
      color:myCarP2.color, slotIndex:myCarP2.slotIndex,
      bullets:myCarP2.bullets.map(b=>[Math.round(b.x),Math.round(b.y)])
    }});

    // Render layers
    drawTrack();
    drawSkidMarks();
    drawOilSlicks();
    drawSmoke();
    drawWalkers();

    // Remote cars
    for (const [pid, car] of remoteCars) {
      if (car) {
        drawCar(car, pid.slice(0,5), false);
        if (car.bullets) {
          ctx.fillStyle = car.color || '#fff';
          for (const [bx,by] of car.bullets) { ctx.beginPath(); ctx.arc(bx,by,3,0,Math.PI*2); ctx.fill(); }
        }
      }
    }
    // AI cars
    for (const ai of aiCars) {
      if (ai.exploded) {
        if (ai.explodeTimer > 0) {
          const t = 1 - ai.explodeTimer/0.7;
          ctx.globalAlpha = ai.explodeTimer/0.7;
          ctx.beginPath(); ctx.arc(ai.x, ai.y, CAR_RADIUS*(1+t*3.5), 0, Math.PI*2);
          ctx.fillStyle = t < 0.5 ? '#ffee44' : '#ff6600'; ctx.fill(); ctx.globalAlpha = 1;
        }
      } else {
        drawCar(ai, ai.isAggro ? 'AI!' : 'AI', false);
      }
    }
    if (myCarP2) { drawCar(myCarP2, 'P2', false); drawBullets(myCarP2.bullets, myCarP2.color); }
    if (myCar)   { drawCar(myCar,   'P1', true);  drawBullets(myCar.bullets,   myCar.color);   }

    // Laser beams on top of everything
    if (myCar?.laserBeams)   drawLaserBeams(myCar.laserBeams,   myCar.laserLevel,   '#00ccff');
    if (myCarP2?.laserBeams) drawLaserBeams(myCarP2.laserBeams, myCarP2.laserLevel, '#ffcc00');

    drawHUD();

    const totalReady = slots.filter(s => s.ready).length;
    if (totalReady > 0 && finishOrder.length >= totalReady) lobbyState = 'finish';
  } else if (lobbyState === 'finish') {
    drawFinish();
  }
  requestAnimationFrame(loop);
}

// ============================================================
// INIT
// ============================================================
connect();
claimSlot();
requestAnimationFrame(loop);
