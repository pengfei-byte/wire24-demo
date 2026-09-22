function iceGatheringComplete(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

export class R2Client {
  constructor({ credentials, remoteVideo, onEvent, onError, onEnded, onRemoteStream }) {
    this.credentials = credentials;
    this.remoteVideo = remoteVideo;
    this.onEvent = onEvent;
    this.onError = onError;
    this.onEnded = onEnded;
    this.onRemoteStream = onRemoteStream;
    this.lastEventId = null;
    this.seen = new Set();
    this.ws = null;
    this.pc = null;
    this.closed = false;
    this.ready = false;
    this.mediaConnectedSent = false;
    this.clientSeq = 0;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.droppedAt = 0;
  }

  send(type, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.clientSeq += 1;
    this.ws.send(
      JSON.stringify({
        type,
        id: `c-${this.clientSeq}-${Date.now()}`,
        data,
      })
    );
  }

  say(text, turnId = `turn_${crypto.randomUUID()}`) {
    this.send("turn.submit", {
      turn_id: turnId,
      text,
      client_sent_at_ms: Date.now(),
    });
    return turnId;
  }

  connectSocket() {
    const { control_url, session_id, control_token } = this.credentials;
    const url = new URL(control_url);
    url.searchParams.set("session_id", session_id);
    if (this.lastEventId) url.searchParams.set("resume_from", this.lastEventId);
    const ws = new WebSocket(url.toString(), ["r2.v1", `r2.token.${control_token}`]);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.droppedAt = 0;
      if (!this.ready) this.send("session.start", {});
    };

    ws.onmessage = (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.data);
      } catch {
        return;
      }
      if (msg.id) {
        if (this.seen.has(msg.id)) return;
        this.seen.add(msg.id);
        this.lastEventId = msg.id;
      }
      this.handle(msg);
    };

    ws.onclose = (ev) => {
      if (this.closed) return;
      if (ev.code === 1000 || ev.code === 4401 || ev.code === 4403 || ev.code === 4409) {
        this.closed = true;
        this.onEnded?.({ reason: `ws_${ev.code}` });
        this.teardown();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    if (!this.droppedAt) this.droppedAt = Date.now();
    if (Date.now() - this.droppedAt > 10_000) {
      this.closed = true;
      this.onEnded?.({ reason: "resume_window" });
      this.teardown();
      return;
    }
    const delay = [500, 1000, 2000][Math.min(this.reconnectAttempt, 2)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connectSocket();
    }, delay);
  }

  async handle(msg) {
    this.onEvent?.(msg);
    switch (msg.type) {
      case "session.ready":
        this.ready = true;
        this.reconnectAttempt = 0;
        this.droppedAt = 0;
        await this.negotiate();
        break;
      case "media.answer":
        if (this.pc && msg.data?.sdp) {
          await this.pc.setRemoteDescription({
            type: "answer",
            sdp: msg.data.sdp,
          });
        }
        break;
      case "session.ended":
        this.closed = true;
        this.onEnded?.(msg.data || {});
        this.teardown();
        break;
      case "error":
        this.onError?.(msg.data || msg);
        break;
      default:
        break;
    }
  }

  async negotiate() {
    if (this.closed) return;
    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* ignore */
      }
    }
    const pc = new RTCPeerConnection({
      iceServers: this.credentials.ice_servers || [],
    });
    this.pc = pc;
    this.mediaConnectedSent = false;

    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });

    pc.ontrack = (e) => {
      const inbound = e.streams[0] || new MediaStream([e.track]);
      if (this.remoteVideo) {
        let mixed = this.remoteVideo.srcObject;
        if (!(mixed instanceof MediaStream)) {
          mixed = inbound;
          this.remoteVideo.srcObject = mixed;
        } else if (e.track && !mixed.getTracks().some((track) => track.id === e.track.id)) {
          mixed.addTrack(e.track);
        }
        this.remoteVideo.play().catch(() => {});
      }
      if (e.track?.kind === "audio") this.onRemoteStream?.(inbound, e.track);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && !this.mediaConnectedSent) {
        this.mediaConnectedSent = true;
        this.send("media.connected", {});
      }
      if (pc.connectionState === "failed" && !this.closed && this.ready) {
        this.negotiate().catch(() => {});
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    await iceGatheringComplete(pc, 5000);
    this.send("media.offer", { sdp: pc.localDescription.sdp });
  }

  start() {
    this.connectSocket();
  }

  close(reason = "client_closed") {
    if (this.closed) return;
    this.closed = true;
    try {
      this.send("session.close", { reason });
    } catch {
      /* ignore */
    }
    setTimeout(() => this.teardown(), 250);
  }

  teardown() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (this.remoteVideo) this.remoteVideo.srcObject = null;
  }
}
