// Multiplayer Racing Game Client

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const roomInput = document.getElementById('roomInput');
const joinBtn = document.getElementById('joinBtn');
const statusDiv = document.getElementById('status');

let signalingWs = null;
let peerConnections = new Map(); // peerId -> RTCPeerConnection
let dataChannels = new Map(); // peerId -> RTCDataChannel
let myPeerId = null;
let players = new Map(); // peerId -> {x, y, angle, color}
let myPlayer = { x: 400, y: 500, angle: -Math.PI/2, speed: 0, color: 'blue' };

const SIGNALING_URL = '/gm4/api/signal/ws';

joinBtn.addEventListener('click', joinGame);

function joinGame() {
  const room = roomInput.value.trim() || '';
  myPeerId = 'player-' + Math.random().toString(36).substr(2, 9);
  players.set(myPeerId, myPlayer);

  const url = room ? `${SIGNALING_URL}?room=${encodeURIComponent(room)}&peerId=${myPeerId}` : `${SIGNALING_URL}?peerId=${myPeerId}`;
  signalingWs = new WebSocket(url);

  signalingWs.onopen = () => {
    statusDiv.textContent = 'Connected to signaling server';
  };

  signalingWs.onmessage = handleSignalingMessage;

  signalingWs.onclose = () => {
    statusDiv.textContent = 'Disconnected';
  };

  // Start game loop
  requestAnimationFrame(gameLoop);
}

function handleSignalingMessage(event) {
  const data = JSON.parse(event.data);

  if (data.type === 'peers') {
    // Connect to existing peers
    data.peers.forEach(peerId => {
      if (peerId !== myPeerId) {
        createPeerConnection(peerId, true); // initiator
      }
    });
  } else if (data.type === 'peer-joined') {
    // New peer joined, connect if not already
    if (data.peerId !== myPeerId && !peerConnections.has(data.peerId)) {
      createPeerConnection(data.peerId, true);
    }
  } else if (data.type === 'peer-left') {
    // Peer left, clean up
    if (peerConnections.has(data.peerId)) {
      peerConnections.get(data.peerId).close();
      peerConnections.delete(data.peerId);
      dataChannels.delete(data.peerId);
      players.delete(data.peerId);
    }
  } else if (data.type === 'signal') {
    // Handle WebRTC signaling
    handleSignal(data.from, data.signal);
  }
}

function createPeerConnection(peerId, initiator) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  peerConnections.set(peerId, pc);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal(peerId, { type: 'candidate', candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      statusDiv.textContent = `Connected to ${peerConnections.size} peers`;
    }
  };

  const dc = pc.createDataChannel('game', { negotiated: true, id: 0 });
  dataChannels.set(peerId, dc);

  dc.onopen = () => {
    console.log(`Data channel open with ${peerId}`);
    // Send initial state
    dc.send(JSON.stringify({ type: 'update', player: myPlayer }));
  };

  dc.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'update') {
      players.set(peerId, data.player);
    }
  };

  if (initiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      sendSignal(peerId, { type: 'offer', sdp: offer.sdp });
    });
  }
}

function handleSignal(from, signal) {
  const pc = peerConnections.get(from);
  if (!pc) return;

  if (signal.type === 'offer') {
    pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    pc.createAnswer().then(answer => {
      pc.setLocalDescription(answer);
      sendSignal(from, { type: 'answer', sdp: answer.sdp });
    });
  } else if (signal.type === 'answer') {
    pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
  } else if (signal.type === 'candidate') {
    pc.addIceCandidate(signal.candidate);
  }
}

function sendSignal(to, signal) {
  if (signalingWs && signalingWs.readyState === WebSocket.OPEN) {
    signalingWs.send(JSON.stringify({ type: 'signal', to, signal }));
  }
}

// Input handling
const keys = {};
document.addEventListener('keydown', (e) => { keys[e.code] = true; });
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

function updatePlayer() {
  if (keys['ArrowUp'] || keys['KeyW']) {
    myPlayer.speed = Math.min(myPlayer.speed + 0.1, 5);
  } else if (keys['ArrowDown'] || keys['KeyS']) {
    myPlayer.speed = Math.max(myPlayer.speed - 0.1, -2);
  } else {
    myPlayer.speed *= 0.95; // friction
  }

  if (keys['ArrowLeft'] || keys['KeyA']) {
    myPlayer.angle -= 0.05;
  }
  if (keys['ArrowRight'] || keys['KeyD']) {
    myPlayer.angle += 0.05;
  }

  myPlayer.x += Math.cos(myPlayer.angle) * myPlayer.speed;
  myPlayer.y += Math.sin(myPlayer.angle) * myPlayer.speed;

  // Boundaries
  myPlayer.x = Math.max(20, Math.min(780, myPlayer.x));
  myPlayer.y = Math.max(20, Math.min(580, myPlayer.y));
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Draw track (simple rectangle)
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.strokeRect(10, 10, 780, 580);

  // Draw players
  players.forEach((player, id) => {
    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.rotate(player.angle);
    ctx.fillStyle = player.color;
    ctx.fillRect(-10, -5, 20, 10);
    ctx.restore();

    // Label
    ctx.fillStyle = '#fff';
    ctx.fillText(id, player.x - 20, player.y - 15);
  });
}

function gameLoop() {
  updatePlayer();

  // Send update to peers
  dataChannels.forEach(dc => {
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'update', player: myPlayer }));
    }
  });

  draw();
  requestAnimationFrame(gameLoop);
}