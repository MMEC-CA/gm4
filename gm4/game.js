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

// Track (rounded-rectangle, clockwise in screen coords)
const TCX = GW / 2, TCY = GH / 2;
const O_HW = 560, O_HH = 290, O_R = 145;   // outer boundary: half-width, half-height, corner-radius
const I_HW = 310, I_HH = 110, I_R = 70;    // inner island:   half-width, half-height, corner-radius

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
    data.peers.forEach(id => { if (id !== myPeerId) createPc(id, true); });
  } else if (data.type === 'peer-joined') {
    if (data.peerId !== myPeerId && !pcs.has(data.peerId)) createPc(data.peerId, true);
  } else if (data.type === 'peer-left') {
    cleanupPeer(data.peerId);
  } else if (data.type === 'signal') {
    handleSignal(data.from, data.signal);
  }
}

function createPc(peerId, initiator) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pcs.set(peerId, pc);

  pc.onicecandidate = e => {
    if (e.candidate) sendSig(peerId, { type: 'candidate', candidate: e.candidate });
  };

  const dc = pc.createDataChannel('game', { negotiated: true, id: 0 });
  dcs.set(peerId, dc);

  dc.onopen = () => {
    // Send full lobby state so late joiners get current snapshot
    dc.send(JSON.stringify({
      type: 'lobby-sync',
      slots: slots.map((s, i) => ({ ...s, index: i })),
      lobbyState,
      countdownTimer,
    }));
  };

  dc.onmessage = e => handleMsg(peerId, JSON.parse(e.data));

  if (initiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      sendSig(peerId, { type: 'offer', sdp: offer.sdp });
    });
  }
}

function handleSignal(from, sig) {
  let pc = pcs.get(from);
  if (!pc) { createPc(from, false); pc = pcs.get(from); }
  if (sig.type === 'offer') {
    pc.setRemoteDescription({ type: 'offer', sdp: sig.sdp });
    pc.createAnswer().then(ans => {
      pc.setLocalDescription(ans);
      sendSig(from, { type: 'answer', sdp: ans.sdp });
    });
  } else if (sig.type === 'answer') {
    pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp });
  } else if (sig.type === 'candidate') {
    pc.addIceCandidate(sig.candidate);
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

    case 'lobby-sync':
      data.slots.forEach(s => {
        if (s.peerId && s.peerId !== myPeerId && s.peerId !== myP2PeerId) {
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
      break;

    case 'lobby-join':
      if (data.peerId !== myPeerId) {
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

// Signed-distance function for a rounded rectangle centred at (TCX, TCY).
// Returns < 0 inside, 0 on surface, > 0 outside.
function sdfRR(px, py, hw, hh, r) {
  const qx = Math.abs(px - TCX) - hw + r;
  const qy = Math.abs(py - TCY) - hh + r;
  return Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, qy), 0) - r;
}

// Unit outward normal of a rounded-rectangle SDF (numerical gradient).
function rrNormal(px, py, hw, hh, r) {
  const e = 1;
  const dx = sdfRR(px + e, py, hw, hh, r) - sdfRR(px - e, py, hw, hh, r);
  const dy = sdfRR(px, py + e, hw, hh, r) - sdfRR(px, py - e, hw, hh, r);
  const len = Math.sqrt(dx * dx + dy * dy);
  return len < 0.001 ? { nx: 1, ny: 0 } : { nx: dx / len, ny: dy / len };
}

function bounceOnWalls(car) {
  let vx = Math.cos(car.angle) * car.speed;
  let vy = Math.sin(car.angle) * car.speed;
  let bounced = false;

  // Outside outer boundary — push inward and reflect
  const od = sdfRR(car.x, car.y, O_HW, O_HH, O_R);
  if (od > -1) {
    const { nx, ny } = rrNormal(car.x, car.y, O_HW, O_HH, O_R);
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
  const id = sdfRR(car.x, car.y, I_HW, I_HH, I_R);
  if (id < 1) {
    const { nx, ny } = rrNormal(car.x, car.y, I_HW, I_HH, I_R);
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

// Start grid: right-side straight, 2 columns × 4 rows, cars facing south (clockwise)
function getStartPos(index) {
  const col = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: 1085 - col * 55,
    y: 225 + row * 40,
    angle: Math.PI / 2
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
    nextSector: 1,
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

  // P2 fire — ShiftLeft, ControlLeft, or Tab
  const p2Firing = keys['ShiftLeft'] || keys['ControlLeft'] || keys['Tab'];
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
  // Grass
  ctx.fillStyle = '#1e4d0f';
  ctx.fillRect(0, 0, GW, GH);

  // Asphalt (outer rounded-rect with 12 px visual margin beyond bounce boundary)
  ctx.beginPath();
  ctx.roundRect(TCX - O_HW - 12, TCY - O_HH - 12, (O_HW + 12) * 2, (O_HH + 12) * 2, O_R + 12);
  ctx.fillStyle = '#3a3a3a';
  ctx.fill();

  // Inner grass island
  ctx.beginPath();
  ctx.roundRect(TCX - I_HW + 12, TCY - I_HH + 12, (I_HW - 12) * 2, (I_HH - 12) * 2, I_R - 12);
  ctx.fillStyle = '#1e4d0f';
  ctx.fill();

  // Outer white border
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(TCX - O_HW - 10, TCY - O_HH - 10, (O_HW + 10) * 2, (O_HH + 10) * 2, O_R + 10);
  ctx.stroke();

  // Inner white border
  ctx.beginPath();
  ctx.roundRect(TCX - I_HW + 10, TCY - I_HH + 10, (I_HW - 10) * 2, (I_HH - 10) * 2, I_R - 10);
  ctx.stroke();

  // Dashed centre line (midpoint between outer and inner boundaries)
  const MHW = (O_HW + I_HW) / 2, MHH = (O_HH + I_HH) / 2, MR = (O_R + I_R) / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.setLineDash([24, 24]);
  ctx.beginPath();
  ctx.roundRect(TCX - MHW, TCY - MHH, MHW * 2, MHH * 2, MR);
  ctx.stroke();
  ctx.setLineDash([]);

  // Start/finish line — right-side straight at y = TCY
  const sfX1 = TCX + I_HW - 10, sfX2 = TCX + O_HW + 10;
  const sqW = 12, sqH = 10;
  const cols = Math.floor((sfX2 - sfX1) / sqW);
  for (let i = 0; i < cols; i++) {
    ctx.fillStyle = (i % 2 === 0) ? '#fff' : '#111';
    ctx.fillRect(sfX1 + i * sqW, TCY - sqH / 2, sqW, sqH);
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
  if (!myCar) return;

  const displayLap = Math.min(myCar.lap + 1, TOTAL_LAPS);

  // Lap box
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(12, 12, 160, 62);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('LAP ' + displayLap + ' / ' + TOTAL_LAPS, 22, 38);
  ctx.font = '14px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText(Math.round(Math.abs(myCar.speed)) + ' px/s', 22, 62);

  // Position (P1 car's rank among all cars)
  const allCars = [...remoteCars.values(),
    { sectorsPassed: myCar.sectorsPassed, peerId: myPeerId },
    ...(myCarP2 ? [{ sectorsPassed: myCarP2.sectorsPassed, peerId: myP2PeerId }] : [])
  ];
  allCars.sort((a, b) => (b.sectorsPassed ?? 0) - (a.sectorsPassed ?? 0));
  const pos = allCars.findIndex(c => c.peerId === myPeerId) + 1;
  const sfx = ['st', 'nd', 'rd'];
  const suf = sfx[pos - 1] || 'th';
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(GW - 104, 12, 92, 62);
  ctx.fillStyle = pos === 1 ? '#ffe030' : '#fff';
  ctx.font = 'bold 36px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(pos + suf, GW - 16, 56);

  // Timer
  const elapsed = (performance.now() - raceStartTime) / 1000;
  const mins = Math.floor(elapsed / 60);
  const secs = (elapsed % 60).toFixed(1).padStart(4, '0');
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(GW / 2 - 76, 12, 152, 42);
  ctx.fillStyle = '#ddd';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(mins + ':' + secs, GW / 2, 38);

  // Pre-race countdown overlay (first 3s)
  const sinceStart = (performance.now() - raceStartTime) / 1000;
  if (sinceStart < 3.0) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, GW, GH);
    const count = Math.ceil(3.0 - sinceStart);
    ctx.fillStyle = '#ffe030';
    ctx.font = 'bold 180px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(count, GW / 2, GH / 2 + 60);
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

    // Car-to-car collisions
    if (myCar && myCarP2) collideCars(myCar, myCarP2);
    for (const remCar of remoteCars.values()) {
      if (myCar)   collideCarOneWay(myCar, remCar);
      if (myCarP2) collideCarOneWay(myCarP2, remCar);
    }

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
