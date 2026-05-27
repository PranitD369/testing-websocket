// Minimal test client for the Gemini Live Reliability Lab.
// Drives the backend with reconnection, mode-aware capture, and failure-injection toggles.

const $ = (id) => document.getElementById(id);
const log = (msg, ...rest) => {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `[${ts}] ${msg} ${rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ')}\n`;
  $('log').textContent = (line + $('log').textContent).slice(0, 16000);
  console.log(msg, ...rest);
};

const state = {
  ws: null,
  sessionId: localStorage.getItem('sessionId') || '',
  reconnectAttempts: 0,
  reconnectTimer: null,
  manualDisconnect: false,
  media: null,
  captureTimer: null,
  audioCtx: null,
  mediaRecorder: null,
  mode: 'HD_VIDEO',
  capture: { maxFps: 1, audioOnly: false, photoMode: false },
  inject: { dropFrames: false, stallPongs: false },
  nextFrameNum: 0,
};

if (state.sessionId) $('session-input').value = state.sessionId;

const setBadge = (el, text, cls = '') => {
  el.textContent = text;
  el.className = `badge ${cls}`.trim();
};

function setConnStatus(status) {
  const map = { connected: 'ok', reconnecting: 'warn', disconnected: 'err', error: 'err' };
  setBadge($('conn-status'), status, map[status] ?? '');
}

function connect() {
  if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
    log('already connected');
    return;
  }
  state.manualDisconnect = false;
  state.sessionId = $('session-input').value.trim() || state.sessionId;
  if (!state.sessionId) {
    state.sessionId = `c_${Math.random().toString(36).slice(2, 14)}`;
    $('session-input').value = state.sessionId;
  }
  localStorage.setItem('sessionId', state.sessionId);
  setBadge($('session-badge'), state.sessionId.slice(0, 14));

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?sessionId=${encodeURIComponent(state.sessionId)}`;
  log('ws.connecting', url);
  setConnStatus('reconnecting');

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.addEventListener('open', () => {
    log('ws.open');
    state.reconnectAttempts = 0;
    setConnStatus('connected');
    $('btn-connect').disabled = true;
    $('btn-disconnect').disabled = false;
  });

  ws.addEventListener('message', (ev) => handleServerMessage(ev.data));

  ws.addEventListener('close', (ev) => {
    log('ws.close', { code: ev.code, reason: ev.reason });
    $('btn-connect').disabled = false;
    $('btn-disconnect').disabled = true;
    setConnStatus('disconnected');
    if (!state.manualDisconnect) scheduleReconnect();
  });

  ws.addEventListener('error', (ev) => {
    log('ws.error', String(ev));
    setConnStatus('error');
  });
}

function scheduleReconnect() {
  state.reconnectAttempts += 1;
  if (state.reconnectAttempts > 12) {
    log('ws.reconnect.giveup');
    return;
  }
  const base = Math.min(250 * Math.pow(2, state.reconnectAttempts), 30_000);
  const delay = Math.round(base + Math.random() * 0.3 * base);
  log('ws.reconnect.in', delay + 'ms', `(attempt ${state.reconnectAttempts})`);
  setConnStatus('reconnecting');
  state.reconnectTimer = setTimeout(() => connect(), delay);
}

function disconnect() {
  state.manualDisconnect = true;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.ws) state.ws.close(1000, 'manual');
}

function send(obj) {
  if (state.inject.dropFrames && obj.type === 'realtimeInput' && Math.random() < 0.5) {
    return; // simulate dropped outbound
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify(obj));
}

function handleServerMessage(data) {
  let msg;
  try {
    msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
  } catch {
    return;
  }
  if (msg.type === 'ping') {
    if (state.inject.stallPongs) return;
    send({ type: 'pong', t: msg.t });
    return;
  }
  if (msg.type === 'hello') {
    log('hello', msg);
    setBadge($('mode-badge'), msg.mode);
    state.mode = msg.mode;
    state.capture = msg.capture;
    applyCaptureHint();
    return;
  }
  if (msg.type === 'modeChange') {
    log('modeChange', msg);
    state.mode = msg.mode;
    state.capture = msg.capture;
    setBadge($('mode-badge'), msg.mode, msg.mode === 'PHOTO_MODE' ? 'err' : msg.mode === 'AUDIO_ONLY' ? 'warn' : 'ok');
    applyCaptureHint();
    return;
  }
  if (msg.type === 'upstreamReady') {
    log('upstream.ready');
    return;
  }
  if (msg.type === 'upstreamGaveUp') {
    log('upstream.giveup', msg.message);
    return;
  }
  if (msg.serverContent) {
    const parts = msg.serverContent.modelTurn?.parts ?? [];
    for (const p of parts) {
      if (p.text) log('model.text', p.text);
      if (p.inlineData?.mimeType?.startsWith('audio/')) {
        playPcm(p.inlineData.data);
      }
    }
    if (msg.serverContent.turnComplete) log('turn.complete');
  }
  if (msg.serverContent || msg.setupComplete || msg.goAway || msg.sessionResumptionUpdate) {
    // Already logged or handled.
  }
}

async function startMedia() {
  try {
    state.media = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'environment' },
      audio: true,
    });
  } catch (err) {
    log('media.error', err.message);
    return;
  }
  $('preview').srcObject = state.media;
  $('btn-start-media').disabled = true;
  $('btn-stop-media').disabled = false;
  applyCaptureHint();
}

function stopMedia() {
  if (state.captureTimer) { clearInterval(state.captureTimer); state.captureTimer = null; }
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') state.mediaRecorder.stop();
  state.media?.getTracks().forEach((t) => t.stop());
  state.media = null;
  $('btn-start-media').disabled = false;
  $('btn-stop-media').disabled = true;
  $('capture-info').textContent = 'capture: idle';
}

function applyCaptureHint() {
  if (!state.media) return;
  if (state.captureTimer) { clearInterval(state.captureTimer); state.captureTimer = null; }
  const { maxFps, audioOnly, photoMode } = state.capture;

  if (photoMode) {
    $('capture-info').textContent = 'capture: photo mode (use Snap & ask)';
    stopAudioStreaming();
    return;
  }

  startAudioStreaming();

  if (audioOnly || maxFps <= 0) {
    $('capture-info').textContent = 'capture: audio only';
    return;
  }
  const intervalMs = Math.max(200, Math.round(1000 / maxFps));
  $('capture-info').textContent = `capture: ${maxFps} fps (every ${intervalMs}ms)`;
  state.captureTimer = setInterval(() => captureFrame(), intervalMs);
}

function captureFrame() {
  const video = $('preview');
  if (!video.videoWidth) return;
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 240;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
  const base64 = dataUrl.split(',')[1];
  const frameId = `f${state.nextFrameNum++}`;
  send({
    type: 'realtimeInput',
    payload: {
      __meta: { frameId },
      video: { mimeType: 'image/jpeg', data: base64 },
    },
  });
  // Echo ack back so the server can measure send→ack delta in this test client.
  setTimeout(() => send({ type: 'frameAck', id: frameId }), 0);
}

function startAudioStreaming() {
  if (state.mediaRecorder || !state.media) return;
  const audioTrack = state.media.getAudioTracks()[0];
  if (!audioTrack) return;
  const audioStream = new MediaStream([audioTrack]);
  // 250ms chunks of webm/opus — small enough to interactively stream.
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const mr = new MediaRecorder(audioStream, { mimeType: mime, audioBitsPerSecond: 32_000 });
  mr.ondataavailable = async (ev) => {
    if (!ev.data || !ev.data.size) return;
    const buf = await ev.data.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    send({
      type: 'realtimeInput',
      payload: { audio: { mimeType: mime, data: base64 } },
    });
  };
  mr.start(250);
  state.mediaRecorder = mr;
}

function stopAudioStreaming() {
  if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
    state.mediaRecorder.stop();
  }
  state.mediaRecorder = null;
}

function playPcm(base64) {
  if (!state.audioCtx) state.audioCtx = new AudioContext({ sampleRate: 24000 });
  const ctx = state.audioCtx;
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  // Gemini Live audio is 16-bit PCM, little-endian, 24kHz.
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const float = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) float[i] = samples[i] / 32768;
  const buf = ctx.createBuffer(1, float.length, 24000);
  buf.copyToChannel(float, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

async function snapAndAsk() {
  let photoBlob;
  if (state.media && $('preview').videoWidth) {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    canvas.getContext('2d').drawImage($('preview'), 0, 0, canvas.width, canvas.height);
    photoBlob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  } else {
    log('photo.error', 'no media stream; click Start camera + mic first');
    return;
  }
  const form = new FormData();
  form.append('photo', photoBlob, 'snap.jpg');
  form.append('text', $('photo-question').value || 'What is this?');
  if (state.sessionId) form.append('sessionId', state.sessionId);
  $('photo-reply').textContent = '… thinking …';
  try {
    const resp = await fetch('/fallback/photo', { method: 'POST', body: form });
    const json = await resp.json();
    if (!resp.ok) {
      log('photo.error', json);
      $('photo-reply').textContent = `error: ${json.error ?? resp.status}`;
      return;
    }
    log('photo.reply', { len: json.text?.length });
    $('photo-reply').textContent = json.text;
    if ('speechSynthesis' in window && json.text) {
      const u = new SpeechSynthesisUtterance(json.text);
      window.speechSynthesis.speak(u);
    }
  } catch (err) {
    log('photo.error', err.message);
    $('photo-reply').textContent = `error: ${err.message}`;
  }
}

$('btn-connect').addEventListener('click', () => connect());
$('btn-disconnect').addEventListener('click', () => disconnect());
$('btn-new-session').addEventListener('click', () => {
  state.sessionId = '';
  localStorage.removeItem('sessionId');
  $('session-input').value = '';
  setBadge($('session-badge'), 'no session');
});
$('btn-start-media').addEventListener('click', () => startMedia());
$('btn-stop-media').addEventListener('click', () => stopMedia());
$('btn-snap-ask').addEventListener('click', () => snapAndAsk());
$('btn-kill-socket').addEventListener('click', () => {
  if (state.ws) state.ws.close(4001, 'manual-kill');
});
$('btn-force-photo').addEventListener('click', () => send({ type: 'forceMode', mode: 'PHOTO_MODE' }));
$('btn-force-hd').addEventListener('click', () => send({ type: 'forceMode', mode: 'HD_VIDEO' }));
$('inj-drop-frames').addEventListener('change', (e) => { state.inject.dropFrames = e.target.checked; });
$('inj-stall-pongs').addEventListener('change', (e) => { state.inject.stallPongs = e.target.checked; });

// Auto-connect on load if we have a session id.
if (state.sessionId) connect();
