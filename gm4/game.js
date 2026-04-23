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
const O_HW = 560, O_HH = 290, O_R = 145;   // outer boundary: half-width, half-height, corner-radius
const I_HW = 310, I_HH = 110, I_R = 70;    // inner island:   half-width, half-height, corner-radius
const SC_X = TCX + O_HW - O_HH;            // right semicircle centre x (both outer & inner share it)

const VERSION = '2026-04-23-ac';

// AI car constants
const AI_COUNT = 6;
const AI_SPEED = 255;
const AI_ACCEL = 380;
const AI_TURN_RATE = 2.0;
const AI_AVOID_RADIUS = 55;
const AI_AGGRO_INTERVAL = 15;
const AI_COLORS = ['#e06060', '#60c0a0', '#60a0d0', '#80c880', '#c0b040', '#b060c0'];

// Car constants
const CAR_L = 26, CAR_W = 13;
const MAX_SPEED = 400;   // px/s
const ACCEL = 600;
const BRAKE = 800;
const TURN_RATE = 2.6;   // rad/s at full speed
const FRICTION_K = 1.8;  // speed decay: speed *= e^(-FRICTION_K * dt)

// Weapons & collisions
const BULLET_SPEED = 660;
const BULLET_LIFE = 1.4;   // seconds (travels ~924px)
const FIRE_RATE = 0.09;    // seconds between shots (~11/s)
const HIT_RADIUS = 15;     // px, bullet detection range
const HIT_COOLDOWN = 0.4;  // s invincibility after hit
const HIT_SPIN = 2.5;      // rad/s spin magnitude from bullet hit
const HIT_SPEED_MULT = 0.72;
const HIT_FLASH_DUR = 0.4;
const SPIN_DECAY = 3.0;    // rad/s² decay rate
const WALL_BOUNCE = 0.62;  // speed retained on wall bounce
const CAR_BOUNCE = 0.72;   // speed retained on car-car collision
const CAR_RADIUS = 16;     // px, collision circle radius per car

// ============================================================
// STATE
// ============================================================
let lobbyState = 'lobby'; // lobby | countdown | game | finish
let myPeerId = 'p' + Math.random().toString(36).slice(2, 9);
let mySlotIndex = -1;
let isHost = false;
let slots = Array.from({ length: MAX_SLOTS }, () => ({
  peerId: null, ready: false, progress: 0, holding: false
}));
let countdownTimer = COUNTDOWN_DURATION;
let holdingFlap = false;
let holdStartTime = 0;

// Local P2 player (WASD — same device, left side of keyboard)
let myP2PeerId = myPeerId + '-p2';
let myP2SlotIndex = -1;
let holdingFlapP2 = false;
let holdStartTimeP2 = 0;
let myCarP2 = null;

// Networking
let sigWs = null;
let pcs = new Map();
let dcs = new Map();

// Game
let myCar = null;
let remoteCars = new Map();   // peerId -> car state (from broadcast)
let raceStartTime = 0;
let raceGo = false;           // engines running
let finishOrder = [];         // [{peerId, time}]
let goFlashTimer = 0;

// AI state
let aiCars = [];
let aggroTimer = AI_AGGRO_INTERVAL;
let aggroCar = null;

// Input
const keys = {};
document.addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.repeat) return; // ignore key-repeat for lobby hold actions
  if (e.code === 'Space') { e.preventDefault(); onFlapDown(); }
  if (e.code === 'ArrowUp') {
    if (lobbyState === 'lobby' || lobbyState === 'countdown') { e.preventDefault(); onFlapDown(); }
    else if (lobbyState === 'game') e.preventDefault();
  }
  if (e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    if (lobbyState === 'game') e.preventDefault();
  }
  if (e.code === 'KeyW' && (lobbyState === 'lobby' || lobbyState === 'countdown')) onFlapDownP2();
  if (e.code === 'Tab') e.preventDefault(); // no focus escape during play
});
document.addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'Space' || e.code === 'ArrowUp') onFlapUp();
  if (e.code === 'KeyW') onFlapUpP2();
});

// Canvas
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
  if (!holdingFlap) {  // don't reset timer if already holding
    holdingFlap = true;
    holdStartTime = performance.now();
    slots[mySlotIndex].holding = true;
  }
}

function onFlapUp() {
  if (!holdingFlap) return;
  holdingFlap = false;
  if (mySlotIndex >= 0 && !slots[mySlotIndex].ready) {
    slots[mySlotIndex].holding = false;
    slots[mySlotIndex].progress = 0;
    broadcast({ type: 'lobby-release', peerId: myPeerId });
  }
}

function onFlapDownP2() {
  if (lobbyState !== 'lobby') return;
  if (myP2SlotIndex < 0) claimSlotP2();
  if (myP2SlotIndex < 0) return;
  if (slots[myP2SlotIndex].ready) return;
  if (!holdingFlapP2) {
    holdingFlapP2 = true;
    holdStartTimeP2 = performance.now();
    slots[myP2SlotIndex].holding = true;
  }
}

function onFlapUpP2() {
  if (!holdingFlapP2) return;
  holdingFlapP2 = false;
  if (myP2SlotIndex >= 0 && !slots[myP2SlotIndex].ready) {
    slots[myP2SlotIndex].holding = false;
    slots[myP2SlotIndex].progress = 0;
    broadcast({ type: 'lobby-release', peerId: myP2PeerId });
  }
}

function claimSlot() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (!slots[i].peerId) {
      mySlotIndex = i;
      slots[i].peerId = myPeerId;
      broadcast({ type: 'lobby-join', peerId: myPeerId, slotIndex: i });
      updateHost();
      return;
    }
  }
}

function claimSlotP2() {
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (!slots[i].peerId) {
      myP2SlotIndex = i;
      slots[i].peerId = myP2PeerId;
      broadcast({ type: 'lobby-join', peerId: myP2PeerId, slotIndex: i });
      updateHost();
      return;
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
    slots[mySlotIndex].ready = true;
    slots[mySlotIndex].holding = false;
    holdingFlap = false;
    broadcast({ type: 'lobby-ready', peerId: myPeerId });
    checkCountdownStart();
  }
}

function updateHoldP2(dt) {
  if (!holdingFlapP2 || myP2SlotIndex < 0 || slots[myP2SlotIndex].ready) return;
  const elapsed = (performance.now() - holdStartTimeP2) / 1000;
  const progress = Math.min(100, (elapsed / HOLD_DURATION) * 100);
  slots[myP2SlotIndex].progress = progress;
  broadcast({ type: 'lobby-hold', peerId: myP2PeerId, progress });
  if (progress >= 100) {
    slots[myP2SlotIndex].ready = true;
    slots[myP2SlotIndex].holding = false;
    holdingFlapP2 = false;
    broadcast({ type: 'lobby-ready', peerId: myP2PeerId });
    checkCountdownStart();
  }
}

function checkCountdownStart() {
  if (lobbyState !== 'lobby') return;
  if (slots.some(s => s.ready)) {
    lobbyState = 'countdown';
    countdownTimer = COUNTDOWN_DURATION;
    broadcast({ type: 'lobby-countdown' });
  }
}

function updateCountdown(dt) {
  if (lobbyState !== 'countdown') return;
  // Any new hold resets countdown
  if (slots.some(s => s.holding && !s.ready)) {
    countdownTimer = COUNTDOWN_DURATION;
    return;
  }
  countdownTimer -= dt;
  if (countdownTimer <= 0 && isHost) {
    const playerSlots = [];
    for (let i = 0; i < MAX_SLOTS; i++) {
      if (slots[i].ready) playerSlots.push({ slotIndex: i, peerId: slots[i].peerId });
    }
    const msg = { type: 'game-start', playerSlots, hostPeerId: myPeerId };
    broadcast(msg);
    startGame(msg);
  }
}

// ============================================================
// NETWORKING
// ============================================================
function connect(room) {
  const url = room
    ? `${SIGNALING_URL}?room=${encodeURIComponent(room)}&peerId=${myPeerId}`
    : `${SIGNALING_URL}?peerId=${myPeerId}`;
  sigWs = new WebSocket(url);
  sigWs.onmessage = onSigMsg;
  sigWs.onclose = () => { };
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

  pc.onicecandidate = e => {
    if (e.candidate) sendSig(peerId, e.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') cleanupPeer(peerId);
  };

  const dc = pc.createDataChannel('game', { negotiated: true, id: 0 });
  dcs.set(peerId, dc);

  dc.onopen = () => {
    dc.send(JSON.stringify({
      type: 'lobby-sync',
      slots: slots.map((s, i) => ({ ...s, index: i })),
      lobbyState,
      countdownTimer,
    }));
  };

  dc.onmessage = e => handleMsg(peerId, JSON.parse(e.data));

  if (initiator) {
    pc.createOffer()
      .then(offer => pc.setLocalDescription(offer))
      .then(() => sendSig(peerId, pc.localDescription));
  }
}

function flushCandidates(peerId) {
  const pc = pcs.get(peerId);
  const pending = pendingCandidates.get(peerId);
  if (pc && pc.remoteDescription && pending) {
    pending.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)));
    pendingCandidates.delete(peerId);
  }
}

function handleSignal(from, sig) {
  let pc = pcs.get(from);
  if (!pc) { createPc(from, false); pc = pcs.get(from); }
  if (sig.type === 'offer') {
    pc.setRemoteDescription(new RTCSessionDescription(sig))
      .then(() => pc.createAnswer())
      .then(ans => pc.setLocalDescription(ans))
      .then(() => { sendSig(from, pc.localDescription); flushCandidates(from); });
  } else if (sig.type === 'answer') {
    pc.setRemoteDescription(new RTCSessionDescription(sig))
      .then(() => flushCandidates(from));
  } else if (sig.candidate !== undefined) {
    if (pc.remoteDescription) {
      pc.addIceCandidate(new RTCIceCandidate(sig));
    } else {
      if (!pendingCandidates.has(from)) pendingCandidates.set(from, []);
      pendingCandidates.get(from).push(sig);
    }
  }
}

function sendSig(to, signal) {
  if (sigWs?.readyState === WebSocket.OPEN) {
    sigWs.send(JSON.stringify({ type: 'signal', to, signal }));
  }
}

function cleanupPeer(peerId) {
  pcs.get(peerId)?.close();
  pcs.delete(peerId);
  dcs.delete(peerId);
  remoteCars.delete(peerId);
  remoteCars.delete(peerId + '-p2'); // clean up their local P2 car too
  for (let i = 0; i < MAX_SLOTS; i++) {
    // Remove the peer's P1 and P2 slots
    if (slots[i].peerId === peerId || slots[i].peerId === peerId + '-p2') {
      slots[i] = { peerId: null, ready: false, progress: 0, holding: false };
    }
  }
  updateHost();
  if (lobbyState === 'countdown' && !slots.some(s => s.ready)) {
    lobbyState = 'lobby';
  }
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  dcs.forEach(dc => { if (dc.readyState === 'open') dc.send(s); });
}

function handleMsg(from, data) {
  switch (data.type) {

    case 'lobby-sync': {
      let p1Yielded = false, p2Yielded = false;
      data.slots.forEach(s => {
        if (s.peerId && s.peerId !== myPeerId && s.peerId !== myP2PeerId) {
          if (mySlotIndex === s.index && myPeerId > s.peerId) {
            slots[mySlotIndex] = { peerId: null, ready: false, progress: 0, holding: false };
            mySlotIndex = -1; p1Yielded = true;
          }
          if (myP2SlotIndex === s.index && myP2PeerId > s.peerId) {
            slots[myP2SlotIndex] = { peerId: null, ready: false, progress: 0, holding: false };
            myP2SlotIndex = -1; p2Yielded = true;
          }
          slots[s.index].peerId = s.peerId;
          slots[s.index].ready = s.ready;
          slots[s.index].progress = s.progress;
        }
      });
      if (data.lobbyState === 'countdown' && lobbyState === 'lobby') {
        lobbyState = 'countdown';
        countdownTimer = data.countdownTimer ?? COUNTDOWN_DURATION;
      }
      updateHost();
      if (p1Yielded) claimSlot();
      if (p2Yielded) claimSlotP2();
      break;
    }

    case 'lobby-join':
      if (data.peerId !== myPeerId && data.peerId !== myP2PeerId) {
        if (mySlotIndex === data.slotIndex && myPeerId > data.peerId) {
          slots[mySlotIndex] = { peerId: null, ready: false, progress: 0, holding: false };
          mySlotIndex = -1;
          slots[data.slotIndex].peerId = data.peerId;
          updateHost();
          claimSlot();
          break;
        }
        if (myP2SlotIndex === data.slotIndex && myP2PeerId > data.peerId) {
          slots[myP2SlotIndex] = { peerId: null, ready: false, progress: 0, holding: false };
          myP2SlotIndex = -1;
          slots[data.slotIndex].peerId = data.peerId;
          updateHost();
          claimSlotP2();
          break;
        }
        slots[data.slotIndex].peerId = data.peerId;
        updateHost();
      }
      break;

    case 'lobby-hold':
      for (let i = 0; i < MAX_SLOTS; i++) {
        if (slots[i].peerId === data.peerId) {
          slots[i].holding = true;
          slots[i].progress = data.progress;
          if (lobbyState === 'countdown' && !slots[i].ready) {
            countdownTimer = COUNTDOWN_DURATION;
          }
        }
      }
      break;

    case 'lobby-ready':
      for (let i = 0; i < MAX_SLOTS; i++) {
        if (slots[i].peerId === data.peerId) {
          slots[i].ready = true;
          slots[i].holding = false;
          checkCountdownStart();
        }
      }
      break;

    case 'lobby-release':
      for (let i = 0; i < MAX_SLOTS; i++) {
        if (slots[i].peerId === data.peerId) {
          slots[i].holding = false;
          slots[i].progress = 0;
        }
      }
      break;

    case 'lobby-countdown':
      if (lobbyState === 'lobby') {
        lobbyState = 'countdown';
        countdownTimer = COUNTDOWN_DURATION;
      }
      break;

    case 'game-start':
      if (lobbyState !== 'game' && lobbyState !== 'finish') startGame(data);
      break;

    case 'update':
      if (data.peerId !== myPeerId && data.peerId !== myP2PeerId) {
        remoteCars.set(data.peerId, data.car);
      }
      break;

    case 'finished':
      if (!finishOrder.find(f => f.peerId === data.peerId)) {
        finishOrder.push({ peerId: data.peerId, time: data.time });
      }
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
  if (a >= -P / 4 && a < P / 4) return 0;     // right
  if (a >= P / 4 && a < 3 * P / 4) return 1;  // bottom
  if (a < -3 * P / 4 || a >= 3 * P / 4) return 2; // left
  return 3;                                      // top
}

// SDF for the D-shape outer boundary.
// Left portion: rectangular with rounded left corners; right portion: semicircle.
// Returns < 0 inside, 0 on surface, > 0 outside.
function sdfOuter(px, py) {
  if (px >= SC_X) return Math.sqrt((px - SC_X) ** 2 + (py - TCY) ** 2) - O_HH;
  const lx = TCX - O_HW + O_R, ty = TCY - O_HH + O_R, by = TCY + O_HH - O_R;
  if (px < lx && py < ty) return Math.sqrt((px - lx) ** 2 + (py - ty) ** 2) - O_R;
  if (px < lx && py > by) return Math.sqrt((px - lx) ** 2 + (py - by) ** 2) - O_R;
  return -Math.min(px - (TCX - O_HW), O_HH - Math.abs(py - TCY));
}

// SDF for the D-shape inner island boundary.
function sdfInner(px, py) {
  if (px >= SC_X) return Math.sqrt((px - SC_X) ** 2 + (py - TCY) ** 2) - I_HH;
  const lx = TCX - I_HW + I_R, ty = TCY - I_HH + I_R, by = TCY + I_HH - I_R;
  if (px < lx && py < ty) return Math.sqrt((px - lx) ** 2 + (py - ty) ** 2) - I_R;
  if (px < lx && py > by) return Math.sqrt((px - lx) ** 2 + (py - by) ** 2) - I_R;
  return -Math.min(px - (TCX - I_HW), I_HH - Math.abs(py - TCY));
}

function outerNormal(px, py) {
  const e = 1;
  const dx = sdfOuter(px + e, py) - sdfOuter(px - e, py);
  const dy = sdfOuter(px, py + e) - sdfOuter(px, py - e);
  const len = Math.sqrt(dx * dx + dy * dy);
  return len < 0.001 ? { nx: 1, ny: 0 } : { nx: dx / len, ny: dy / len };
}

function innerNormal(px, py) {
  const e = 1;
  const dx = sdfInner(px + e, py) - sdfInner(px - e, py);
  const dy = sdfInner(px, py + e) - sdfInner(px, py - e);
  const len = Math.sqrt(dx * dx + dy * dy);
  return len < 0.001 ? { nx: 1, ny: 0 } : { nx: dx / len, ny: dy / len };
}

function bounceOnWalls(car) {
  let vx = Math.cos(car.angle) * car.speed;
  let vy = Math.sin(car.angle) * car.speed;
  let bounced = false;

  // Outside outer boundary — push inward and reflect
  const od = sdfOuter(car.x, car.y);
  if (od > -1) {
    const { nx, ny } = outerNormal(car.x, car.y);
    car.x -= nx * (od + 1);
    car.y -= ny * (od + 1);
    const dot = vx * nx + vy * ny;
    if (dot > 0) {
      vx -= 2 * dot * nx; vy -= 2 * dot * ny;
      vx *= WALL_BOUNCE;   vy *= WALL_BOUNCE;
      car.spinVel += (Math.random() - 0.5) * 2;
      bounced = true;
    }
  }

  // Inside inner island — push outward and reflect
  const id = sdfInner(car.x, car.y);
  if (id < 1) {
    const { nx, ny } = innerNormal(car.x, car.y);
    car.x += nx * (1 - id);
    car.y += ny * (1 - id);
    const dot = vx * nx + vy * ny;
    if (dot < 0) {
      vx -= 2 * dot * nx; vy -= 2 * dot * ny;
      vx *= WALL_BOUNCE;   vy *= WALL_BOUNCE;
      car.spinVel += (Math.random() - 0.5) * 2;
      bounced = true;
    }
  }

  if (bounced) {
    car.speed = Math.min(Math.sqrt(vx * vx + vy * vy), MAX_SPEED);
    if (car.speed > 1) car.angle = Math.atan2(vy, vx);
  }
}

// Start grid: top straight, 2 lanes × 4 rows, cars facing right (clockwise)
function getStartPos(index) {
  const col = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: 835 - row * 55,
    y: 135 + col * 50,
    angle: 0
  };
}

// ============================================================
// GAME START & CAR CREATION
// ============================================================
function makeCar(slotIndex, posIndex) {
  const pos = getStartPos(posIndex);
  return {
    x: pos.x, y: pos.y,
    angle: pos.angle,
    speed: 0,
    prevSector: getSector(pos.x, pos.y),
    nextSector: (getSector(pos.x, pos.y) + 1) % 4,
    sectorsPassed: 0,
    lap: 0,
    finished: false,
    finishTime: 0,
    color: SLOT_COLORS[slotIndex],
    slotIndex,
    // physics extras
    spinVel: 0,
    hitFlash: 0,
    hitCooldown: 0,
    fireTimer: 0,
    bullets: [],   // own fired bullets
  };
}

function startGame(msg) {
  lobbyState = 'game';
  isHost = (msg.hostPeerId === myPeerId);
  raceStartTime = performance.now();
  raceGo = false;
  goFlashTimer = 0;
  finishOrder = [];
  remoteCars.clear();

  const playerSlots = msg.playerSlots || [];
  const myEntry = playerSlots.find(ps => ps.peerId === myPeerId);
  if (myEntry) {
    myCar = makeCar(myEntry.slotIndex, playerSlots.indexOf(myEntry));
  }
  const myP2Entry = playerSlots.find(ps => ps.peerId === myP2PeerId);
  if (myP2Entry) {
    myCarP2 = makeCar(myP2Entry.slotIndex, playerSlots.indexOf(myP2Entry));
  }
  initAICars();
  // Start race after 3 seconds
  setTimeout(() => {
    raceGo = true;
    goFlashTimer = 1.2;
  }, 3000);
}

// ============================================================
// CAR PHYSICS
// ============================================================
function updateCar(car, dt) {
  car.hitCooldown = Math.max(0, car.hitCooldown - dt);
  car.hitFlash    = Math.max(0, car.hitFlash - dt);
  car.spinVel    *= Math.exp(-SPIN_DECAY * dt);
  car.angle      += car.spinVel * dt;

  if (car.finished || !raceGo) return;

  // P1 — Arrow keys
  if (keys['ArrowUp']) {
    car.speed = Math.min(car.speed + ACCEL * dt, MAX_SPEED);
  } else if (keys['ArrowDown']) {
    car.speed = Math.max(car.speed - BRAKE * dt, -MAX_SPEED * 0.35);
  } else {
    car.speed *= Math.exp(-FRICTION_K * dt);
    if (Math.abs(car.speed) < 2) car.speed = 0;
  }

  const grip = Math.abs(car.speed) / MAX_SPEED;
  if (keys['ArrowLeft'])  car.angle -= TURN_RATE * grip * dt;
  if (keys['ArrowRight']) car.angle += TURN_RATE * grip * dt;

  // P1 fire — ShiftRight, ControlRight, or Slash
  const p1Firing = keys['ShiftRight'] || keys['ControlRight'] || keys['Slash'];
  tryFire(car, p1Firing, dt);
  updateBullets(car.bullets, dt);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;

  bounceOnWalls(car);

  // Lap counting via sector transitions
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
  if (finishOrder.length >= totalPlayers) {
    setTimeout(() => { lobbyState = 'finish'; }, 2000);
  }
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
}

function tryFire(car, firing, dt) {
  car.fireTimer = Math.max(0, car.fireTimer - dt);
  if (!firing || car.finished || car.fireTimer > 0) return;
  car.fireTimer = FIRE_RATE;
  const bvx = Math.cos(car.angle) * (BULLET_SPEED + Math.abs(car.speed));
  const bvy = Math.sin(car.angle) * (BULLET_SPEED + Math.abs(car.speed));
  car.bullets.push({
    x: car.x + Math.cos(car.angle) * (CAR_L / 2 + 5),
    y: car.y + Math.sin(car.angle) * (CAR_L / 2 + 5),
    vx: bvx, vy: bvy, life: BULLET_LIFE
  });
}

function updateBullets(bullets, dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    if (b.life <= 0) bullets.splice(i, 1);
  }
}

// Check if remote cars' bullets hit a local car
function checkRemoteHits(localCar) {
  for (const remCar of remoteCars.values()) {
    if (!remCar.bullets) continue;
    for (const [bx, by] of remCar.bullets) {
      const dx = bx - localCar.x, dy = by - localCar.y;
      if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS) {
        applyHit(localCar);
        return;
      }
    }
  }
}

// Check if a local car's own bullets hit another local car
function checkLocalBulletHits(shooterBullets, targetCar) {
  for (const b of shooterBullets) {
    const dx = b.x - targetCar.x, dy = b.y - targetCar.y;
    if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS) {
      applyHit(targetCar);
      return;
    }
  }
}

// Two-body car collision (both affected — used for local vs local)
function collideCars(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  const distSq = dx * dx + dy * dy;
  const minDist = CAR_RADIUS * 2;
  if (distSq >= minDist * minDist || distSq < 0.01) return;
  const dist = Math.sqrt(distSq);
  const nx = dx / dist, ny = dy / dist;
  const push = (minDist - dist) * 0.5;
  a.x += nx * push; a.y += ny * push;
  b.x -= nx * push; b.y -= ny * push;
  let avx = Math.cos(a.angle) * a.speed, avy = Math.sin(a.angle) * a.speed;
  let bvx = Math.cos(b.angle) * b.speed, bvy = Math.sin(b.angle) * b.speed;
  const relVel = (avx - bvx) * nx + (avy - bvy) * ny;
  if (relVel >= 0) return;
  const impulse = -(1 + CAR_BOUNCE) * relVel * 0.5;
  avx += impulse * nx; avy += impulse * ny;
  bvx -= impulse * nx; bvy -= impulse * ny;
  a.speed = Math.min(Math.sqrt(avx * avx + avy * avy), MAX_SPEED * 1.3);
  b.speed = Math.min(Math.sqrt(bvx * bvx + bvy * bvy), MAX_SPEED * 1.3);
  if (a.speed > 1) a.angle = Math.atan2(avy, avx);
  if (b.speed > 1) b.angle = Math.atan2(bvy, bvx);
  a.spinVel += (Math.random() - 0.5) * 3;
  b.spinVel += (Math.random() - 0.5) * 3;
}

// One-body collision — only push mine away from other (remote car)
function collideCarOneWay(mine, other) {
  const dx = mine.x - other.x, dy = mine.y - other.y;
  const distSq = dx * dx + dy * dy;
  const minDist = CAR_RADIUS * 2;
  if (distSq >= minDist * minDist || distSq < 0.01) return;
  const dist = Math.sqrt(distSq);
  const nx = dx / dist, ny = dy / dist;
  mine.x = other.x + nx * minDist;
  mine.y = other.y + ny * minDist;
  let vx = Math.cos(mine.angle) * mine.speed;
  let vy = Math.sin(mine.angle) * mine.speed;
  const dot = vx * nx + vy * ny;
  if (dot < 0) {
    vx -= 2 * dot * nx; vy -= 2 * dot * ny;
    vx *= CAR_BOUNCE;   vy *= CAR_BOUNCE;
    mine.speed = Math.min(Math.sqrt(vx * vx + vy * vy), MAX_SPEED * 1.3);
    if (mine.speed > 1) mine.angle = Math.atan2(vy, vx);
    mine.spinVel += (Math.random() - 0.5) * 3;
  }
}

// P2 car physics — WASD controls
function updateCarP2(car, dt) {
  car.hitCooldown = Math.max(0, car.hitCooldown - dt);
  car.hitFlash    = Math.max(0, car.hitFlash - dt);
  car.spinVel    *= Math.exp(-SPIN_DECAY * dt);
  car.angle      += car.spinVel * dt;

  if (car.finished || !raceGo) return;

  // P2 — WASD
  if (keys['KeyW']) {
    car.speed = Math.min(car.speed + ACCEL * dt, MAX_SPEED);
  } else if (keys['KeyS']) {
    car.speed = Math.max(car.speed - BRAKE * dt, -MAX_SPEED * 0.35);
  } else {
    car.speed *= Math.exp(-FRICTION_K * dt);
    if (Math.abs(car.speed) < 2) car.speed = 0;
  }

  const grip = Math.abs(car.speed) / MAX_SPEED;
  if (keys['KeyA']) car.angle -= TURN_RATE * grip * dt;
  if (keys['KeyD']) car.angle += TURN_RATE * grip * dt;

  // P2 fire — ShiftLeft, ControlLeft, Tab, or F
  const p2Firing = keys['ShiftLeft'] || keys['ControlLeft'] || keys['Tab'] || keys['KeyF'];
  tryFire(car, p2Firing, dt);
  updateBullets(car.bullets, dt);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  bounceOnWalls(car);

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
// RENDERING — TRACK
// ============================================================
function drawTrack() {
  // Build a D-shape canvas path (clockwise): left side = rounded rect, right side = semicircle.
  function dPath(lx, ty, by, r) {
    const cy = (ty + by) / 2, rr = (by - ty) / 2;
    ctx.beginPath();
    ctx.moveTo(lx + r, ty);
    ctx.lineTo(SC_X, ty);
    ctx.arc(SC_X, cy, rr, -Math.PI / 2, Math.PI / 2);              // right hairpin
    ctx.lineTo(lx + r, by);
    ctx.arc(lx + r, by - r, r, Math.PI / 2, Math.PI);              // bottom-left corner
    ctx.lineTo(lx, ty + r);
    ctx.arc(lx + r, ty + r, r, Math.PI, 3 * Math.PI / 2);          // top-left corner
    ctx.closePath();
  }

  // Grass
  ctx.fillStyle = '#1e4d0f';
  ctx.fillRect(0, 0, GW, GH);

  // Asphalt (outer D with 12 px visual margin)
  dPath(TCX - O_HW - 12, TCY - O_HH - 12, TCY + O_HH + 12, O_R + 12);
  ctx.fillStyle = '#3a3a3a';
  ctx.fill();

  // Inner grass island
  dPath(TCX - I_HW + 12, TCY - I_HH + 12, TCY + I_HH - 12, I_R - 12);
  ctx.fillStyle = '#1e4d0f';
  ctx.fill();

  // Outer white border
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 5;
  dPath(TCX - O_HW - 10, TCY - O_HH - 10, TCY + O_HH + 10, O_R + 10);
  ctx.stroke();

  // Inner white border
  dPath(TCX - I_HW + 10, TCY - I_HH + 10, TCY + I_HH - 10, I_R - 10);
  ctx.stroke();

  // Dashed centre line (midpoint between outer and inner boundaries)
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.setLineDash([24, 24]);
  dPath((TCX - O_HW + TCX - I_HW) / 2,
        (TCY - O_HH + TCY - I_HH) / 2,
        (TCY + O_HH + TCY + I_HH) / 2,
        (O_R + I_R) / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Start/finish line — vertical bar on top straight at x = SC_X - 30
  const sfX = SC_X - 30;
  const sfY1 = TCY - O_HH - 2, sfY2 = TCY - I_HH + 2;
  const sqH = 12, sqW = 10;
  const rows = Math.floor((sfY2 - sfY1) / sqH);
  for (let j = 0; j < rows; j++) {
    ctx.fillStyle = (j % 2 === 0) ? '#fff' : '#111';
    ctx.fillRect(sfX - sqW / 2, sfY1 + j * sqH, sqW, sqH);
  }
}

// ============================================================
// RENDERING — CARS
// ============================================================
function drawCar(car, label, isMe) {
  ctx.save();
  ctx.translate(car.x, car.y);
  ctx.rotate(car.angle);

  // Drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(-CAR_L / 2 + 3, -CAR_W / 2 + 3, CAR_L, CAR_W);

  // Body
  ctx.fillStyle = car.color;
  ctx.fillRect(-CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W);

  // Roof/windshield
  ctx.fillStyle = 'rgba(180,230,255,0.65)';
  ctx.fillRect(1, -CAR_W / 2 + 2, CAR_L / 2 - 2, CAR_W - 4);

  // Headlights
  ctx.fillStyle = '#ffff99';
  ctx.fillRect(CAR_L / 2 - 4, -CAR_W / 2 + 2, 4, 3);
  ctx.fillRect(CAR_L / 2 - 4, CAR_W / 2 - 5, 4, 3);

  // Taillights
  ctx.fillStyle = '#ff4444';
  ctx.fillRect(-CAR_L / 2, -CAR_W / 2 + 2, 3, 3);
  ctx.fillRect(-CAR_L / 2, CAR_W / 2 - 5, 3, 3);

  // Hit flash — white overlay
  if (car.hitFlash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, car.hitFlash / HIT_FLASH_DUR) * 0.7})`;
    ctx.fillRect(-CAR_L / 2, -CAR_W / 2, CAR_L, CAR_W);
  }

  ctx.restore();

  // Name label
  ctx.textAlign = 'center';
  ctx.font = isMe ? 'bold 11px monospace' : '10px monospace';
  ctx.fillStyle = isMe ? '#fff' : 'rgba(255,255,255,0.7)';
  ctx.fillText(label, car.x, car.y - 20);
}

function drawBullets(bullets, color) {
  if (!bullets || !bullets.length) return;
  ctx.fillStyle = color;
  for (const b of bullets) {
    const alpha = Math.min(1, b.life * 3);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
    ctx.fill();
    // Tracer line
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ============================================================
// RENDERING — LOBBY
// ============================================================
function drawLobby(dt) {
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, GW, GH);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#444';
  ctx.font = '12px monospace';
  ctx.fillText('v' + VERSION, 10, 18);

  // Title
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 80px monospace';
  ctx.fillText('GRAND PRIX', GW / 2, 110);

  ctx.fillStyle = '#777';
  ctx.font = '18px monospace';
  ctx.fillText('share this page to invite friends  •  up to 8 players', GW / 2, 148);

  // URL
  ctx.fillStyle = '#555';
  ctx.font = '14px monospace';
  ctx.fillText(window.location.href, GW / 2, 174);

  // Slots
  const slotW = 128, slotH = 110, gap = 14;
  const totalW = MAX_SLOTS * slotW + (MAX_SLOTS - 1) * gap;
  const sx0 = GW / 2 - totalW / 2;
  const sy0 = 210;

  for (let i = 0; i < MAX_SLOTS; i++) {
    const sx = sx0 + i * (slotW + gap);
    const s = slots[i];
    const col = SLOT_COLORS[i];

    // Background
    ctx.fillStyle = s.peerId ? col + '22' : '#181818';
    ctx.strokeStyle = s.peerId ? col : '#333';
    ctx.lineWidth = s.peerId === myPeerId ? 3 : 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(sx, sy0, slotW, slotH, 8);
    else ctx.rect(sx, sy0, slotW, slotH);
    ctx.fill();
    ctx.stroke();

    // Colour swatch circle
    ctx.beginPath();
    ctx.arc(sx + slotW / 2, sy0 + 26, 20, 0, 2 * Math.PI);
    ctx.fillStyle = s.peerId ? col : '#333';
    ctx.fill();

    // Mini car icon inside swatch
    if (s.peerId) {
      ctx.save();
      ctx.translate(sx + slotW / 2, sy0 + 26);
      ctx.fillStyle = '#000';
      ctx.fillRect(-9, -4, 18, 8);
      ctx.fillStyle = col;
      ctx.fillRect(-8, -3, 16, 6);
      ctx.restore();
    }

    ctx.textAlign = 'center';
    if (s.ready) {
      ctx.fillStyle = '#44ff88';
      ctx.font = 'bold 14px monospace';
      ctx.fillText('READY!', sx + slotW / 2, sy0 + 66);
    } else if (s.holding) {
      ctx.fillStyle = '#282828';
      ctx.fillRect(sx + 12, sy0 + 60, slotW - 24, 10);
      ctx.fillStyle = col;
      ctx.fillRect(sx + 12, sy0 + 60, (slotW - 24) * s.progress / 100, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '10px monospace';
      ctx.fillText('HOLD...', sx + slotW / 2, sy0 + 58);
    } else if (s.peerId) {
      const label = s.peerId === myPeerId ? '← P1' : s.peerId === myP2PeerId ? '← P2' : 'joined';
      ctx.fillStyle = (s.peerId === myPeerId || s.peerId === myP2PeerId) ? '#aaa' : '#555';
      ctx.font = '11px monospace';
      ctx.fillText(label, sx + slotW / 2, sy0 + 68);
    } else {
      ctx.fillStyle = '#333';
      ctx.font = '12px monospace';
      ctx.fillText('OPEN', sx + slotW / 2, sy0 + 72);
    }
  }

  // Instructions
  ctx.textAlign = 'center';
  const inY = sy0 + slotH + 34;
  if (mySlotIndex < 0) {
    ctx.fillStyle = '#eee';
    ctx.font = 'bold 24px monospace';
    ctx.fillText('↑ or SPACE = join as P1  •  W = join as P2', GW / 2, inY);
  } else if (!slots[mySlotIndex]?.ready) {
    ctx.fillStyle = '#eee';
    ctx.font = 'bold 24px monospace';
    ctx.fillText('Hold ↑ / SPACE to ready (P1)' + (myP2SlotIndex >= 0 ? '  •  Hold W (P2)' : '  •  W = add P2'), GW / 2, inY);
    ctx.fillStyle = '#555';
    ctx.font = '15px monospace';
    ctx.fillText('release to cancel', GW / 2, inY + 28);
  } else {
    ctx.fillStyle = '#44ff88';
    ctx.font = 'bold 24px monospace';
    ctx.fillText('Waiting for race to start...', GW / 2, inY);
  }

  ctx.fillStyle = '#444';
  ctx.font = '15px monospace';
  ctx.fillText('P1: ↑↓←→  •  P2: WASD  •  Race ' + TOTAL_LAPS + ' laps clockwise', GW / 2, inY + 60);

  // Countdown overlay
  if (lobbyState === 'countdown') {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, GW, GH);
    ctx.fillStyle = '#ffe030';
    ctx.font = 'bold 140px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(countdownTimer), GW / 2, GH / 2 + 50);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px monospace';
    ctx.fillText('GET READY!', GW / 2, GH / 2 - 50);
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

  function ordinal(n) {
    return n + (['st', 'nd', 'rd'][n - 1] || 'th');
  }

  function drawPlayerBox(car, peerId, label, fireHint, alignRight) {
    const W = 196, H = 76;
    const x = alignRight ? GW - W - 12 : 12;
    const y = 12;

    ctx.fillStyle = 'rgba(0,0,0,0.68)';
    ctx.fillRect(x, y, W, H);

    // colour stripe on the inside edge
    ctx.fillStyle = car.color;
    ctx.fillRect(alignRight ? x : x + W - 5, y, 5, H);

    const pos = allCars.findIndex(c => c.peerId === peerId) + 1;
    const lap = Math.min(car.lap + 1, TOTAL_LAPS);

    ctx.textAlign = alignRight ? 'right' : 'left';
    const tx = alignRight ? x + W - 10 : x + 10;

    ctx.fillStyle = '#888';
    ctx.font = '12px monospace';
    ctx.fillText(label + '  fire:' + fireHint, tx, y + 16);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px monospace';
    ctx.fillText('LAP ' + lap + ' / ' + TOTAL_LAPS, tx, y + 40);

    ctx.fillStyle = '#aaa';
    ctx.font = '13px monospace';
    ctx.fillText(Math.round(Math.abs(car.speed)) + ' px/s', tx, y + 58);

    ctx.fillStyle = pos === 1 ? '#ffe030' : '#ccc';
    ctx.font = 'bold 20px monospace';
    ctx.fillText(ordinal(pos), tx, y + 76);
  }

  if (myCar)   drawPlayerBox(myCar,   myPeerId,   'P1 ↑↓←→', '/',     false);
  if (myCarP2) drawPlayerBox(myCarP2, myP2PeerId, 'P2 WASD',  'F/Tab', true);

  // Timer — centre top
  const elapsed = (performance.now() - raceStartTime) / 1000;
  const mins = Math.floor(elapsed / 60);
  const secs = (elapsed % 60).toFixed(1).padStart(4, '0');
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(GW / 2 - 76, 12, 152, 42);
  ctx.fillStyle = '#ddd';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(mins + ':' + secs, GW / 2, 38);

  // Pre-race countdown overlay (first 3 s)
  if (elapsed < 3.0) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, GW, GH);
    ctx.fillStyle = '#ffe030';
    ctx.font = 'bold 180px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(Math.ceil(3.0 - elapsed), GW / 2, GH / 2 + 60);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 36px monospace';
    ctx.fillText('RACE IN...', GW / 2, GH / 2 - 60);
  } else if (goFlashTimer > 0) {
    const alpha = Math.min(1, goFlashTimer);
    ctx.fillStyle = 'rgba(0,0,0,' + (alpha * 0.4) + ')';
    ctx.fillRect(0, 0, GW, GH);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#44ff88';
    ctx.font = 'bold 200px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GO!', GW / 2, GH / 2 + 60);
    ctx.globalAlpha = 1;
  }
}

// ============================================================
// RENDERING — FINISH
// ============================================================
function drawFinish() {
  drawTrack();
  for (const [pid, car] of remoteCars) {
    if (car) drawCar(car, pid.slice(0, 5), false);
  }
  if (myCarP2) drawCar(myCarP2, 'P2', false);
  if (myCar) drawCar(myCar, 'P1', true);

  // Darkened overlay
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, GW, GH);

  const bw = 460, bh = 80 + finishOrder.length * 50 + 60;
  const bx = GW / 2 - bw / 2, by = GH / 2 - bh / 2;

  ctx.fillStyle = '#141414';
  ctx.strokeStyle = '#ffe030';
  ctx.lineWidth = 3;
  if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 12);
  else ctx.rect(bx, by, bw, bh);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#ffe030';
  ctx.font = 'bold 42px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('RACE OVER!', GW / 2, by + 54);

  const medals = ['🥇', '🥈', '🥉'];
  finishOrder.forEach((f, i) => {
    const rowY = by + 100 + i * 50;
    const mins = Math.floor(f.time / 60);
    const secs = (f.time % 60).toFixed(2).padStart(5, '0');
    const name = f.peerId === myPeerId ? 'P1(you)' : f.peerId === myP2PeerId ? 'P2(you)' : f.peerId.slice(0, 7);
    ctx.fillStyle = i === 0 ? '#ffe030' : '#ccc';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText((i + 1) + '.  ' + name.padEnd(8) + '  ' + mins + ':' + secs, GW / 2, rowY);
  });

  ctx.fillStyle = '#555';
  ctx.font = '16px monospace';
  ctx.fillText('refresh to play again', GW / 2, by + bh - 18);
}

// ============================================================
// AI CARS
// ============================================================

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

function getTrackTangent(px, py, cw) {
  const { nx, ny } = innerNormal(px, py);
  return cw ? { tx: -ny, ty: nx } : { tx: ny, ty: -nx };
}

function makeAICar(index) {
  const cw = index < 3;
  const starts = [
    { x: 720, y: 120, a: 0 },              // CW 0: top straight, outer lane
    { x: 460, y: 600, a: Math.PI },         // CW 1: bottom straight, outer lane
    { x: 1150, y: 300, a: Math.PI / 2 },    // CW 2: right hairpin, outer lane
    { x: 440, y: 200, a: Math.PI },         // CCW 3: top straight, inner lane
    { x: 720, y: 520, a: 0 },              // CCW 4: bottom straight, inner lane
    { x: 1070, y: 420, a: -Math.PI / 2 },   // CCW 5: right hairpin, inner lane
  ];
  const s = starts[index];
  return {
    x: s.x, y: s.y, angle: s.a,
    speed: AI_SPEED * 0.6,
    cw, isAI: true, color: AI_COLORS[index],
    spinVel: 0, hitFlash: 0, hitCooldown: 0,
    isAggro: false, aggroTarget: null,
    prevSector: getSector(s.x, s.y),
    nextSector: (getSector(s.x, s.y) + 1) % 4,
    sectorsPassed: 0, lap: 0, finished: false, finishTime: 0,
    slotIndex: -1, fireTimer: 0, bullets: [],
  };
}

function initAICars() {
  aiCars = [];
  for (let i = 0; i < AI_COUNT; i++) aiCars.push(makeAICar(i));
  aggroTimer = AI_AGGRO_INTERVAL;
  aggroCar = null;
}

function getLeadPlayer() {
  const players = [myCar, myCarP2, ...remoteCars.values()].filter(c => c && !c.finished);
  if (!players.length) return null;
  return players.reduce((b, c) =>
    (c.lap * 100 + c.sectorsPassed) > (b.lap * 100 + b.sectorsPassed) ? c : b);
}

function updateAICar(car, dt) {
  if (!raceGo) return;
  car.hitCooldown = Math.max(0, car.hitCooldown - dt);
  car.hitFlash = Math.max(0, car.hitFlash - dt);
  car.spinVel *= Math.exp(-SPIN_DECAY * dt);
  car.angle += car.spinVel * dt;

  const { tx, ty } = getTrackTangent(car.x, car.y, car.cw);
  let desired = Math.atan2(ty, tx);

  if (car.isAggro && car.aggroTarget) {
    const t = car.aggroTarget;
    const dx = t.x - car.x, dy = t.y - car.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 30)
      desired = lerpAngle(desired, Math.atan2(dy, dx), Math.min(0.45, 120 / dist));
  }

  const others = [myCar, myCarP2, ...remoteCars.values(), ...aiCars].filter(c => c && c !== car);
  let ax = 0, ay = 0;
  for (const o of others) {
    const dx = car.x - o.x, dy = car.y - o.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < AI_AVOID_RADIUS && d > 0.5) {
      const f = 1 - d / AI_AVOID_RADIUS;
      ax += (dx / d) * f;
      ay += (dy / d) * f;
    }
  }
  const avoidMag = Math.sqrt(ax * ax + ay * ay);
  if (avoidMag > 0.05)
    desired = lerpAngle(desired, Math.atan2(ay, ax), Math.min(avoidMag * 0.7, 0.6));

  const laneTarget = car.cw ? -50 : -130;
  const od = sdfOuter(car.x, car.y);
  const laneErr = od - laneTarget;
  if (Math.abs(laneErr) > 8) {
    const { nx, ny } = outerNormal(car.x, car.y);
    desired = lerpAngle(desired, Math.atan2(-laneErr * ny, -laneErr * nx), 0.12);
  }

  let diff = desired - car.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  car.angle += Math.sign(diff) * Math.min(Math.abs(diff) * 4, AI_TURN_RATE) * dt;

  const topSpeed = car.isAggro ? AI_SPEED * 1.15 : AI_SPEED;
  if (car.speed < topSpeed) car.speed = Math.min(car.speed + AI_ACCEL * dt, topSpeed);
  else car.speed *= Math.exp(-FRICTION_K * dt);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  bounceOnWalls(car);

  const sec = getSector(car.x, car.y);
  if (sec !== car.prevSector && sec === car.nextSector) {
    car.sectorsPassed++;
    car.lap = Math.floor(car.sectorsPassed / 4);
    car.nextSector = (car.nextSector + 1) % 4;
  }
  car.prevSector = sec;
}

function updateAggroState(dt) {
  aggroTimer -= dt;
  if (aggroTimer <= 0) {
    aggroTimer = AI_AGGRO_INTERVAL;
    if (aggroCar) { aggroCar.isAggro = false; aggroCar.aggroTarget = null; }
    aggroCar = aiCars.length ? aiCars[Math.floor(Math.random() * aiCars.length)] : null;
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
    updateHold(dt);
    updateHoldP2(dt);
    updateCountdown(dt);
    drawLobby(dt);

  } else if (lobbyState === 'game') {
    // Update physics
    if (myCar)   updateCar(myCar, dt);
    if (myCarP2) updateCarP2(myCarP2, dt);

    // AI updates
    updateAggroState(dt);
    for (const ai of aiCars) updateAICar(ai, dt);

    // Car-to-car collisions
    if (myCar && myCarP2) collideCars(myCar, myCarP2);
    for (const remCar of remoteCars.values()) {
      if (myCar)   collideCarOneWay(myCar, remCar);
      if (myCarP2) collideCarOneWay(myCarP2, remCar);
    }
    for (const ai of aiCars) {
      if (myCar)   collideCars(myCar, ai);
      if (myCarP2) collideCars(myCarP2, ai);
    }
    for (let i = 0; i < aiCars.length; i++)
      for (let j = i + 1; j < aiCars.length; j++)
        collideCars(aiCars[i], aiCars[j]);

    // Bullet hit detection — remote bullets vs local cars
    if (myCar)   checkRemoteHits(myCar);
    if (myCarP2) checkRemoteHits(myCarP2);
    // Local P1 bullets vs P2 and vice versa
    if (myCar && myCarP2) {
      checkLocalBulletHits(myCar.bullets, myCarP2);
      checkLocalBulletHits(myCarP2.bullets, myCar);
    }

    // Broadcast (bullets as compact [x,y] pairs)
    if (myCar) {
      broadcast({
        type: 'update', peerId: myPeerId,
        car: { x: myCar.x, y: myCar.y, angle: myCar.angle, speed: myCar.speed,
               sectorsPassed: myCar.sectorsPassed, lap: myCar.lap,
               finished: myCar.finished, color: myCar.color, slotIndex: myCar.slotIndex,
               bullets: myCar.bullets.map(b => [Math.round(b.x), Math.round(b.y)]) }
      });
    }
    if (myCarP2) {
      broadcast({
        type: 'update', peerId: myP2PeerId,
        car: { x: myCarP2.x, y: myCarP2.y, angle: myCarP2.angle, speed: myCarP2.speed,
               sectorsPassed: myCarP2.sectorsPassed, lap: myCarP2.lap,
               finished: myCarP2.finished, color: myCarP2.color, slotIndex: myCarP2.slotIndex,
               bullets: myCarP2.bullets.map(b => [Math.round(b.x), Math.round(b.y)]) }
      });
    }

    // Render
    drawTrack();
    for (const [pid, car] of remoteCars) {
      if (car) {
        drawCar(car, pid.slice(0, 5), false);
        // Remote bullets (stored as [x,y] pairs, draw without tracer)
        if (car.bullets) {
          ctx.fillStyle = car.color || '#fff';
          for (const [bx, by] of car.bullets) {
            ctx.beginPath(); ctx.arc(bx, by, 3, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }
    for (const ai of aiCars) drawCar(ai, ai.isAggro ? 'AI!' : 'AI', false);
    if (myCarP2) { drawCar(myCarP2, 'P2', false); drawBullets(myCarP2.bullets, myCarP2.color); }
    if (myCar)   { drawCar(myCar,   'P1', true);  drawBullets(myCar.bullets,   myCar.color);   }
    drawHUD();

    const totalReady = slots.filter(s => s.ready).length;
    if (totalReady > 0 && finishOrder.length >= totalReady) {
      lobbyState = 'finish';
    }

  } else if (lobbyState === 'finish') {
    drawFinish();
  }

  requestAnimationFrame(loop);
}

// ============================================================
// INIT
// ============================================================
connect();   // no room code — signaling server groups by LAN/IP automatically
claimSlot();
requestAnimationFrame(loop);
