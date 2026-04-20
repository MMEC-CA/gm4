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

// Track (oval, clockwise in screen coords)
const TCX = GW / 2, TCY = GH / 2 + 20;
const ORX = 510, ORY = 240;  // outer half-radii
const IRX = 300, IRY = 100;  // inner half-radii
const MID_RX = (ORX + IRX) / 2;
const MID_RY = (ORY + IRY) / 2;

// Car constants
const CAR_L = 26, CAR_W = 13;
const MAX_SPEED = 400;   // px/s
const ACCEL = 600;
const BRAKE = 800;
const TURN_RATE = 2.6;   // rad/s at full speed
const FRICTION_K = 1.8;  // speed decay: speed *= e^(-FRICTION_K * dt)

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
  if (e.code === 'Space') { e.preventDefault(); onFlapDown(); }
  if ((e.code === 'ArrowUp' || e.code === 'ArrowDown' ||
       e.code === 'ArrowLeft' || e.code === 'ArrowRight') && lobbyState === 'game') {
    e.preventDefault();
  }
});
document.addEventListener('keyup', e => {
  keys[e.code] = false;
  if (e.code === 'Space') onFlapUp();
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
  holdingFlap = true;
  holdStartTime = performance.now();
  slots[mySlotIndex].holding = true;
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
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (slots[i].peerId === peerId) {
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
        if (s.peerId && s.peerId !== myPeerId) {
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
      if (data.peerId !== myPeerId) {
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

function pushToTrack(car) {
  let dx = car.x - TCX, dy = car.y - TCY;

  // Outside outer ellipse → push to surface
  const outerVal = (dx / ORX) ** 2 + (dy / ORY) ** 2;
  if (outerVal > 1.0) {
    const u = dx / ORX, v = dy / ORY;
    const len = Math.sqrt(u * u + v * v);
    car.x = TCX + (u / len) * ORX;
    car.y = TCY + (v / len) * ORY;
    car.speed *= 0.25;
    dx = car.x - TCX; dy = car.y - TCY;
  }

  // Inside inner ellipse → push to surface
  const innerVal = (dx / IRX) ** 2 + (dy / IRY) ** 2;
  if (innerVal < 1.0) {
    const u = dx / IRX, v = dy / IRY;
    const len = Math.sqrt(u * u + v * v);
    if (len < 0.001) { car.x = TCX + IRX + 1; car.y = TCY; }
    else {
      car.x = TCX + (u / len) * IRX;
      car.y = TCY + (v / len) * IRY;
    }
    car.speed *= 0.25;
  }
}

// Start positions: right side of oval, grid of 2 columns × 4 rows
function getStartPos(index) {
  const col = index % 2;
  const row = Math.floor(index / 2);
  return {
    x: TCX + MID_RX - col * 60,
    y: TCY - 30 + row * 44,
    angle: Math.PI / 2   // pointing south = clockwise start direction
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
    nextSector: 1,         // next sector to enter (sectors 0→1→2→3→0 = 1 lap)
    sectorsPassed: 0,
    lap: 0,
    finished: false,
    finishTime: 0,
    color: SLOT_COLORS[slotIndex],
    slotIndex,
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
    const posIdx = playerSlots.indexOf(myEntry);
    myCar = makeCar(myEntry.slotIndex, posIdx);
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
  if (car.finished || !raceGo) return;

  if (keys['ArrowUp'] || keys['KeyW']) {
    car.speed = Math.min(car.speed + ACCEL * dt, MAX_SPEED);
  } else if (keys['ArrowDown'] || keys['KeyS']) {
    car.speed = Math.max(car.speed - BRAKE * dt, -MAX_SPEED * 0.35);
  } else {
    car.speed *= Math.exp(-FRICTION_K * dt);
    if (Math.abs(car.speed) < 2) car.speed = 0;
  }

  const grip = Math.abs(car.speed) / MAX_SPEED;
  if (keys['ArrowLeft'] || keys['KeyA']) car.angle -= TURN_RATE * grip * dt;
  if (keys['ArrowRight'] || keys['KeyD']) car.angle += TURN_RATE * grip * dt;

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;

  pushToTrack(car);

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
// RENDERING — TRACK
// ============================================================
function drawTrack() {
  // Grass
  ctx.fillStyle = '#1e4d0f';
  ctx.fillRect(0, 0, GW, GH);

  // Asphalt surface (outer oval)
  ctx.beginPath();
  ctx.ellipse(TCX, TCY, ORX + 12, ORY + 12, 0, 0, 2 * Math.PI);
  ctx.fillStyle = '#3a3a3a';
  ctx.fill();

  // Inner grass
  ctx.beginPath();
  ctx.ellipse(TCX, TCY, IRX - 12, IRY - 12, 0, 0, 2 * Math.PI);
  ctx.fillStyle = '#1e4d0f';
  ctx.fill();

  // White borders
  ctx.strokeStyle = '#ddd';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.ellipse(TCX, TCY, ORX + 10, ORY + 10, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(TCX, TCY, IRX - 10, IRY - 10, 0, 0, 2 * Math.PI);
  ctx.stroke();

  // Dashed centre line
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.setLineDash([24, 24]);
  ctx.beginPath();
  ctx.ellipse(TCX, TCY, MID_RX, MID_RY, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);

  // Start/finish line — crosses track on right side at equator (y = TCY)
  const sfX1 = TCX + IRX - 10, sfX2 = TCX + ORX + 10;
  // Chequered squares
  const sqW = 12, sqH = 10;
  const totalW = sfX2 - sfX1;
  const cols = Math.floor(totalW / sqW);
  for (let i = 0; i < cols; i++) {
    ctx.fillStyle = (i % 2 === 0) ? '#fff' : '#111';
    ctx.fillRect(sfX1 + i * sqW, TCY - sqH / 2, sqW, sqH);
  }

  // Sector debug dots (disabled)
  // drawSectorDots();
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

  ctx.restore();

  // Name label
  ctx.textAlign = 'center';
  ctx.font = isMe ? 'bold 11px monospace' : '10px monospace';
  ctx.fillStyle = isMe ? '#fff' : 'rgba(255,255,255,0.7)';
  ctx.fillText(label, car.x, car.y - 20);
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
      // Progress bar
      ctx.fillStyle = '#282828';
      ctx.fillRect(sx + 12, sy0 + 60, slotW - 24, 10);
      ctx.fillStyle = col;
      ctx.fillRect(sx + 12, sy0 + 60, (slotW - 24) * s.progress / 100, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '10px monospace';
      ctx.fillText('HOLD...', sx + slotW / 2, sy0 + 58);
    } else if (s.peerId) {
      ctx.fillStyle = s.peerId === myPeerId ? '#aaa' : '#555';
      ctx.font = '11px monospace';
      ctx.fillText(s.peerId === myPeerId ? '← YOU' : 'joined', sx + slotW / 2, sy0 + 68);
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
    ctx.fillText('Press SPACE  or  tap to join', GW / 2, inY);
  } else if (!slots[mySlotIndex]?.ready) {
    ctx.fillStyle = '#eee';
    ctx.font = 'bold 24px monospace';
    ctx.fillText('Hold SPACE to ready up!', GW / 2, inY);
    ctx.fillStyle = '#555';
    ctx.font = '15px monospace';
    ctx.fillText('(release to cancel)', GW / 2, inY + 28);
  } else {
    ctx.fillStyle = '#44ff88';
    ctx.font = 'bold 24px monospace';
    ctx.fillText('Waiting for others...', GW / 2, inY);
  }

  ctx.fillStyle = '#444';
  ctx.font = '15px monospace';
  ctx.fillText('Arrow keys / WASD to drive  •  Race ' + TOTAL_LAPS + ' laps to win  •  clockwise', GW / 2, inY + 60);

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

  // Position
  const allCars = [...remoteCars.values(), { accAngle: myCar.sectorsPassed, peerId: myPeerId }];
  allCars.sort((a, b) => (b.sectorsPassed ?? b.accAngle ?? 0) - (a.sectorsPassed ?? a.accAngle ?? 0));
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
  if (myCar) drawCar(myCar, 'YOU', true);

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
    const name = f.peerId === myPeerId ? 'YOU' : f.peerId.slice(0, 7);
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
    updateCountdown(dt);
    drawLobby(dt);

  } else if (lobbyState === 'game') {
    if (myCar) {
      updateCar(myCar, dt);
      // Broadcast local car state at ~30Hz (every other frame is fine too, we broadcast every frame)
      broadcast({
        type: 'update',
        peerId: myPeerId,
        car: {
          x: myCar.x, y: myCar.y,
          angle: myCar.angle,
          speed: myCar.speed,
          sectorsPassed: myCar.sectorsPassed,
          lap: myCar.lap,
          finished: myCar.finished,
          color: myCar.color,
          slotIndex: myCar.slotIndex,
        }
      });
    }

    drawTrack();
    for (const [pid, car] of remoteCars) {
      if (car) drawCar(car, pid.slice(0, 5), false);
    }
    if (myCar) drawCar(myCar, 'YOU', true);
    drawHUD();

    // All ready players finished → go to finish screen after short delay
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
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const connectDiv = document.getElementById('connect');

joinBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  joinBtn.disabled = true;
  connect(room);
  connectDiv.style.display = 'none';
  // Auto-claim a slot immediately
  claimSlot();
});

requestAnimationFrame(loop);
