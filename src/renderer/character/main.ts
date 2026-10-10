// Character window entry: wires the bridge, the 3D character, audio, mic and the overlays.
import './style.css';
import { C2M, M2C, type SpeechAudioPayload } from '@shared/ipc';
import type { Emotion } from '@shared/emotions';
import type { CharacterState } from '@shared/types';
import { AudioPlayer } from './AudioPlayer';
import { CharacterController } from './character/CharacterController';
import { MicCapture } from './MicCapture';
import { OverlayUI } from './OverlayUI';

const bridge = window.mmd;
const app = document.getElementById('app')!;
const canvas = document.createElement('canvas');
canvas.className = 'stage';
app.appendChild(canvas);

const character = new CharacterController(canvas);
character.start();

let state: CharacterState = 'idle';
const sentenceEmotion = new Map<number, { e: Emotion; i: number }>();

const player = new AudioPlayer({
  onStart: (p) => {
    if (!p.preview) bridge.send(C2M.speechPlayed, { sentenceId: p.sentenceId, phase: 'start' });
    character.setEmotion(p.emotion, p.intensity);
    if (p.preview) character.setState('speaking');
  },
  onEnd: (p) => {
    if (!p.preview) bridge.send(C2M.speechPlayed, { sentenceId: p.sentenceId, phase: 'end' });
    sentenceEmotion.delete(p.sentenceId);
    if (!p.preview && !player.playing && state === 'idle') ui.scheduleBubbleHide();
    if (p.preview && !player.playing) character.setState(state);
  },
});
character.setMouthSource(() => player.mouth());

const mic = new MicCapture((pcm) => bridge.send(C2M.micFrame, pcm));

const ui = new OverlayUI(app, {
  submitText: (t) => {
    bridge.send(C2M.inputText, t);
    ui.userEcho(t);
  },
  answer: (id, a) => bridge.send(C2M.approvalAnswer, { id, answer: a }),
  cancel: () => bridge.send(C2M.cancel, undefined),
  inputPanel: (open) => {
    bridge.send(C2M.inputPanel, open);
    if (open) setIgnore(false);
  },
  openLink: (url) => window.open(url, '_blank'),
});

// ---------------- bridge events ----------------

bridge.on(M2C.loadCharacter, async (p) => {
  const view = lastView;
  const r = await character.load(p, view?.physics ?? true);
  bridge.send(C2M.morphReport, r);
  if (!r.modelLoaded && p.modelUrl) ui.toast(`モデルを読み込めませんでした: ${r.error ?? ''}`, 'error');
  placeOverlays();
});

bridge.on(M2C.state, (s) => {
  state = s;
  if (!player.playing || s !== 'idle') character.setState(s);
  ui.setState(s);
  if (s === 'idle') ui.scheduleBubbleHide();
  if (s === 'listening' || s === 'thinking') ui.hideApproval();
});

bridge.on(M2C.sentence, (p) => {
  ui.sentence(p.turnId, p.text, p.emotion);
  if (p.silent) character.setEmotion(p.emotion, p.intensity);
  else sentenceEmotion.set(p.sentenceId, { e: p.emotion, i: p.intensity });
  placeOverlays();
});

bridge.on(M2C.detail, (p) => ui.detailMarkdown(p.turnId, p.markdown));
bridge.on(M2C.userEcho, (p) => ui.userEcho(p.text));
bridge.on(M2C.speechAudio, (p: SpeechAudioPayload) => player.enqueue(p));
bridge.on(M2C.speechStop, () => player.stop());
bridge.on(M2C.approvalRequest, (req) => {
  ui.showApproval(req);
  setIgnore(false);
});
bridge.on(M2C.approvalResolved, () => ui.hideApproval());
bridge.on(M2C.cursor, (c) => {
  // screen → window-local CSS px
  character.lookAt({ x: c.x - c.winX, y: c.y - c.winY });
});
bridge.on(M2C.openInput, () => {
  ui.openInput();
  setIgnore(false);
});
bridge.on(M2C.status, (st) => ui.setServiceStatus(st));
bridge.on(M2C.toast, (t) => ui.toast(t.text, t.kind));
bridge.on(M2C.mood, (m) => character.setMood(m));
bridge.on(M2C.sleepy, (s) => character.setSleepy(s));
bridge.on(M2C.listening, (l) => ui.setMicSpeech(l.speech));
bridge.on(M2C.micCapture, (on) => {
  if (on)
    mic.start().catch((e) => {
      ui.toast(`マイクを使えません: ${(e as Error).message}`, 'error');
    });
  else mic.stop();
});

let lastView: { muted: boolean; fps: number; physics: boolean; scale: number; micEnabled: boolean } | null = null;
bridge.on(M2C.view, (v) => {
  const physicsChanged = lastView && lastView.physics !== v.physics;
  lastView = v;
  character.setFps(v.fps);
  character.setPhysics(v.physics);
  character.setGazeLimit(v.gazeLimit);
  ui.setBubbleEnabled(v.showBubble);
  player.setFilter(v.voiceFilter);
  ui.setMuted(v.muted, !v.micEnabled || v.voiceInput === 'off', v.voiceInput === 'wake');
  if (!v.micEnabled) mic.release();
  if (physicsChanged && v.physics) ui.toast('揺れ物の設定は次にモデルを読み込んだときに反映されます', 'info');
});
bridge.on(M2C.windowBounds, () => onResize());

// ---------------- layout ----------------

function onResize(): void {
  character.resize(window.innerWidth, window.innerHeight);
  placeOverlays();
}
window.addEventListener('resize', onResize);

function placeOverlays(): void {
  const head = character.headScreenPos();
  // bubble goes toward the screen center: if the window sits on the right half, put it on the left
  const winCenter = window.screenX + window.innerWidth / 2;
  const screenCenter = (window.screen as Screen & { availLeft?: number }).availLeft! + window.screen.availWidth / 2;
  ui.placeAroundHead(head, winCenter > screenCenter);
}
setInterval(placeOverlays, 500);

// ---------------- click-through & interaction (spec 3.2, 3.3) ----------------

let ignoring = true;
function setIgnore(v: boolean): void {
  if (v === ignoring) return;
  ignoring = v;
  bridge.send(C2M.ignoreMouse, v);
}

function isUiElement(x: number, y: number): boolean {
  const elAt = document.elementFromPoint(x, y);
  return !!elAt && !!elAt.closest('[data-ui]') && !elAt.closest('.hidden');
}

let lastMove = 0;
let overModel = false;
let drag: { sx: number; sy: number; lx: number; ly: number; moved: boolean } | null = null;

window.addEventListener('mousemove', async (e) => {
  if (drag) {
    const dx = e.screenX - drag.lx;
    const dy = e.screenY - drag.ly;
    if (dx || dy) {
      drag.lx = e.screenX;
      drag.ly = e.screenY;
      if (Math.abs(e.screenX - drag.sx) + Math.abs(e.screenY - drag.sy) > 4) drag.moved = true;
      if (drag.moved) bridge.send(C2M.drag, { dx, dy });
    }
    return;
  }
  const now = performance.now();
  if (now - lastMove < 33) return; // 30 Hz
  lastMove = now;
  if (isUiElement(e.clientX, e.clientY)) {
    overModel = false;
    setIgnore(false);
    return;
  }
  overModel = await character.pick(e.clientX, e.clientY);
  document.body.classList.toggle('over-model', overModel);
  setIgnore(!overModel && !ui.inputOpen);
});

window.addEventListener('mouseleave', () => {
  if (!drag && !ui.inputOpen) setIgnore(true);
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || isUiElement(e.clientX, e.clientY) || !overModel) return;
  drag = { sx: e.screenX, sy: e.screenY, lx: e.screenX, ly: e.screenY, moved: false };
});

window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.moved) {
    bridge.send(C2M.dragEnd, undefined);
    return;
  }
  // a click: head or body reaction (FR-EX-05)
  const head = character.headScreenPos();
  const part = Math.hypot(e.clientX - head.x, e.clientY - head.y) < window.innerHeight * 0.09 ? 'head' : 'body';
  character.touch(part);
  bridge.send(C2M.touch, part);
});

window.addEventListener('dblclick', (e) => {
  if (!overModel || isUiElement(e.clientX, e.clientY)) return;
  ui.openInput();
});

window.addEventListener(
  'wheel',
  (e) => {
    if (!overModel) return;
    e.preventDefault();
    bridge.send(C2M.scale, e.deltaY < 0 ? 1.08 : 1 / 1.08);
  },
  { passive: false },
);

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (overModel) bridge.send(C2M.contextMenu, undefined);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    bridge.send(C2M.cancel, undefined);
    player.stop();
  }
});

// file drop onto the model (FR-IN-06)
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  setIgnore(false);
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files ?? []);
  const paths = bridge.pathsForFiles(files);
  if (paths.length) bridge.send(C2M.inputDrop, paths);
});

bridge.send(C2M.ready, undefined);
