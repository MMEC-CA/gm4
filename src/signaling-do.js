// Durable Object: SignalingRoom
// Manages WebSocket connections for peers in the same WAN IP room.
// Zero storage — all state is in-memory for the lifetime of the DO.

export class SignalingRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // peerId -> WebSocket
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const peerId = url.searchParams.get('peerId');
      if (!peerId) {
        return new Response('peerId required', { status: 400 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server, [peerId]);

      // Send current peer list to new joiner
      const peers = [];
      for (const ws of this.state.getWebSockets()) {
        const tags = this.state.getTags(ws);
        if (tags.length > 0 && tags[0] !== peerId) {
          peers.push(tags[0]);
        }
      }

      server.send(JSON.stringify({
        type: 'peers',
        peers: peers,
      }));

      // Notify existing peers about new joiner
      for (const ws of this.state.getWebSockets()) {
        const tags = this.state.getTags(ws);
        if (tags.length > 0 && tags[0] !== peerId) {
          try {
            ws.send(JSON.stringify({
              type: 'peer-joined',
              peerId: peerId,
            }));
          } catch (e) {
            // WebSocket may be closing
          }
        }
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP status endpoint
    const peers = [];
    for (const ws of this.state.getWebSockets()) {
      const tags = this.state.getTags(ws);
      if (tags.length > 0) peers.push(tags[0]);
    }
    return new Response(JSON.stringify({ peers, count: peers.length }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async webSocketMessage(ws, message) {
    try {
      const data = JSON.parse(message);
      const senderTags = this.state.getTags(ws);
      const senderId = senderTags.length > 0 ? senderTags[0] : null;
      if (!senderId) return;

      if (data.type === 'signal' && data.to) {
        // Relay signal to target peer
        for (const targetWs of this.state.getWebSockets()) {
          const tags = this.state.getTags(targetWs);
          if (tags.length > 0 && tags[0] === data.to) {
            try {
              targetWs.send(JSON.stringify({
                type: 'signal',
                from: senderId,
                signal: data.signal,
              }));
            } catch (e) {
              // Target may be closing
            }
            break;
          }
        }
      }
    } catch (e) {
      // Ignore malformed messages
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const tags = this.state.getTags(ws);
    const peerId = tags.length > 0 ? tags[0] : null;

    if (peerId) {
      // Notify remaining peers
      for (const otherWs of this.state.getWebSockets()) {
        const otherTags = this.state.getTags(otherWs);
        if (otherTags.length > 0 && otherTags[0] !== peerId) {
          try {
            otherWs.send(JSON.stringify({
              type: 'peer-left',
              peerId: peerId,
            }));
          } catch (e) {}
        }
      }
    }

    try { ws.close(code, reason); } catch (e) {}
  }

  async webSocketError(ws, error) {
    try { ws.close(1011, 'WebSocket error'); } catch (e) {}
  }
}