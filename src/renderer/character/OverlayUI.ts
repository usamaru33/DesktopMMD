// SC-01 overlays: speech bubble, status chip, input bar, approval card (SC-02), detail panel (SC-03), toasts.
import { LIMITS } from '@shared/defaults';
import { EMOTION_LABELS, type Emotion } from '@shared/emotions';
import type { ApprovalAnswer, ApprovalRequest, CharacterState, ServiceStatus } from '@shared/types';
import { renderMarkdown } from '../shared/markdown';
import { icon } from './icons';

const STATE_LABEL: Record<CharacterState, string> = {
  idle: '',
  listening: '聞いています',
  thinking: '考え中',
  speaking: '',
  acting: '作業中',
  awaiting: '確認待ち',
  sleeping: 'おやすみ中',
};

export interface OverlayCallbacks {
  submitText(text: string): void;
  answer(id: string, a: ApprovalAnswer): void;
  cancel(): void;
  inputPanel(open: boolean): void;
  openLink(url: string): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export class OverlayUI {
  readonly root: HTMLElement;
  private bubble: HTMLElement;
  private bubbleText: HTMLElement;
  private bubbleMore: HTMLButtonElement;
  private status: HTMLElement;
  /** floating "z z z" beside the head while she sleeps */
  private zzz: HTMLElement;
  private inputBar: HTMLElement;
  private input: HTMLTextAreaElement;
  private approval: HTMLElement;
  private detail: HTMLElement;
  private detailBody: HTMLElement;
  private toasts: HTMLElement;
  private echo: HTMLElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTurn = -999;
  private pendingDetail: string | null = null;
  private approvalTimer: ReturnType<typeof setInterval> | null = null;
  private state: CharacterState = 'idle';
  private flags = { muted: false, micOff: false, voiceOn: false, sidecarDown: false, voicevoxDown: false };
  private micSpeech = false;
  private bubbleEnabled = true;

  constructor(
    parent: HTMLElement,
    private readonly cb: OverlayCallbacks,
  ) {
    this.root = el('div', 'overlay');
    parent.appendChild(this.root);

    this.status = el('div', 'status-chip');
    this.status.dataset.ui = '';
    this.root.appendChild(this.status);
    this.zzz = el('div', 'zzz hidden', '<span>z</span><span>z</span><span>Z</span>');
    this.root.appendChild(this.zzz);

    this.bubble = el('div', 'bubble hidden');
    this.bubble.dataset.ui = '';
    this.bubbleText = el('div', 'bubble-text');
    this.bubbleMore = el('button', 'bubble-more', `${icon('doc')}詳しく`);
    this.bubbleMore.addEventListener('click', () => this.showDetail());
    this.bubble.append(this.bubbleText, this.bubbleMore);
    // 読んでいる間は消さない
    this.bubble.addEventListener('mouseenter', () => this.showBubble());
    this.bubble.addEventListener('mouseleave', () => {
      if (this.state === 'idle') this.scheduleBubbleHide();
    });
    this.root.appendChild(this.bubble);

    this.echo = el('div', 'user-echo hidden');
    this.root.appendChild(this.echo);

    this.detail = el('div', 'detail hidden');
    this.detail.dataset.ui = '';
    const head = el('div', 'detail-head', `<span>${icon('doc')}詳細</span>`);
    const close = el('button', 'icon-btn', icon('close'));
    close.title = '閉じる';
    close.addEventListener('click', () => this.detail.classList.add('hidden'));
    head.appendChild(close);
    this.detailBody = el('div', 'detail-body md');
    this.detailBody.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (a) {
        e.preventDefault();
        this.cb.openLink(a.href);
      }
    });
    this.detail.append(head, this.detailBody);
    this.root.appendChild(this.detail);

    this.approval = el('div', 'approval hidden');
    this.approval.dataset.ui = '';
    this.root.appendChild(this.approval);

    this.toasts = el('div', 'toasts');
    this.root.appendChild(this.toasts);

    this.inputBar = el('div', 'input-bar hidden');
    this.inputBar.dataset.ui = '';
    this.input = el('textarea', 'input');
    this.input.rows = 1;
    this.input.placeholder = '話しかける…（Enterで送信）';
    const send = el('button', 'send-btn', icon('send'));
    send.title = '送信';
    send.addEventListener('click', () => this.submit());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeInput(true);
      }
    });
    this.input.addEventListener('input', () => this.autoSize());
    this.input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!this.input.value.trim() && document.activeElement !== this.input) this.closeInput(false);
      }, 150);
    });
    this.inputBar.append(this.input, send);
    this.root.appendChild(this.inputBar);
    this.renderStatus();
  }

  // ---------------- bubble ----------------

  sentence(turnId: number, text: string, emotion: Emotion): void {
    if (turnId !== this.currentTurn) {
      this.currentTurn = turnId;
      this.bubbleText.textContent = '';
      this.pendingDetail = null;
      this.bubbleMore.style.display = 'none';
    }
    const span = el('span', `s emo-${emotion}`);
    span.textContent = text;
    span.title = EMOTION_LABELS[emotion];
    this.bubbleText.appendChild(span);
    this.bubble.dataset.emotion = emotion;
    this.showBubble();
    this.bubbleText.scrollTop = this.bubbleText.scrollHeight;
  }

  detailMarkdown(turnId: number, md: string): void {
    if (turnId !== this.currentTurn) this.sentence(turnId, '', 'neutral');
    this.pendingDetail = this.pendingDetail ? `${this.pendingDetail}\n\n${md}` : md;
    this.bubbleMore.style.display = '';
    // long content opens the panel right away (spec 3.1 SC-03)
    if (md.length > 120 || /```|\|.*\|/.test(md)) this.showDetail();
  }

  private showDetail(): void {
    if (!this.pendingDetail) return;
    this.detailBody.innerHTML = renderMarkdown(this.pendingDetail);
    this.detail.classList.remove('hidden');
  }

  private cancelHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.bubble.classList.remove('fading');
  }

  private showBubble(): void {
    this.cancelHide();
    if (this.bubbleEnabled) this.bubble.classList.remove('hidden');
  }

  /** 吹き出しの表示/非表示の設定。OFFにしたら今出ているものも消す */
  setBubbleEnabled(on: boolean): void {
    this.bubbleEnabled = on;
    if (!on) this.clearBubble();
  }

  /** 読み終わって2秒ほどでフェードアウトして消す。ミュート中は読み上げの代わりに文字量に応じて待つ。 */
  scheduleBubbleHide(ms = LIMITS.bubbleHideMs): void {
    this.cancelHide();
    if (this.bubble.classList.contains('hidden')) return;
    const wait = ms + (this.flags.muted ? Math.min(6000, (this.bubbleText.textContent?.length ?? 0) * 100) : 0);
    this.hideTimer = setTimeout(() => {
      this.bubble.classList.add('fading');
      this.hideTimer = setTimeout(() => {
        this.bubble.classList.add('hidden');
        this.bubble.classList.remove('fading');
        this.hideTimer = null;
      }, LIMITS.bubbleFadeMs);
    }, wait);
  }

  clearBubble(): void {
    this.cancelHide();
    this.bubble.classList.add('hidden');
  }

  userEcho(text: string): void {
    this.echo.textContent = text;
    this.echo.classList.remove('hidden');
    setTimeout(() => this.echo.classList.add('hidden'), 4000);
  }

  /** Bubble beside the head, flipped toward the screen center when near an edge (spec 3.2). */
  placeAroundHead(head: { x: number; y: number }, preferLeft: boolean): void {
    const w = this.root.clientWidth;
    const bw = Math.min(300, w - 24);
    this.bubble.style.maxWidth = `${bw}px`;
    // 頭より上に置く（下端を頭の少し上に合わせ、足りなければ文字をスクロールにする）。顔や体に被せない
    // 入力欄（上端）が開いているときはその下まで
    const room = Math.max(60, head.y - 40 - (this.inputOpen ? 64 : 8));
    this.bubbleText.style.maxHeight = `${Math.min(210, Math.max(40, room - 50))}px`;
    this.bubble.style.top = '';
    this.bubble.style.bottom = `${Math.max(8, this.root.clientHeight - (head.y - 40))}px`;
    if (preferLeft) {
      this.bubble.style.left = '';
      this.bubble.style.right = `${Math.max(8, w - head.x + 60)}px`;
      this.bubble.classList.add('tail-right');
      this.bubble.classList.remove('tail-left');
    } else {
      this.bubble.style.right = '';
      this.bubble.style.left = `${Math.min(w - bw - 8, head.x + 60)}px`;
      this.bubble.classList.add('tail-left');
      this.bubble.classList.remove('tail-right');
    }
    // keep inside the window
    const r = this.bubble.getBoundingClientRect();
    if (r.left < 8) {
      this.bubble.style.right = '';
      this.bubble.style.left = '8px';
    }
    // 状態表示は頭の真上（吹き出しは横にずらしてあるので被らない）。頭ボーンは頭の付け根なので、
    // 顔に被らないよう頭の大きさ（ウィンドウの高さに比例）ぶん上げる
    const above = Math.max(62, this.root.clientHeight * 0.1);
    this.status.style.top = `${Math.max(4, head.y - above)}px`;
    this.status.style.left = `${head.x}px`;
    // the z's rise from beside the top of the head, on the side away from the bubble
    this.zzz.style.top = `${Math.max(4, head.y - above - 50)}px`;
    this.zzz.style.left = `${preferLeft ? head.x + 40 : head.x - 80}px`;
  }

  // ---------------- status ----------------

  setAsleep(on: boolean): void {
    this.zzz.classList.toggle('hidden', !on);
  }

  /**
   * Move the z's (call once per drawn frame). Animated here rather than in CSS: a CSS animation would repaint
   * the transparent window on its own schedule (60/s), while the sleeping character draws only 15 frames/s.
   */
  tickZzz(time: number): void {
    if (this.zzz.classList.contains('hidden')) return;
    const spans = this.zzz.children;
    for (let i = 0; i < spans.length; i++) {
      const u = (((time / 3.6 - i / 3) % 1) + 1) % 1; // each z: 3.6 s, a third apart
      const el = spans[i] as HTMLElement;
      el.style.transform = `translate(${(22 * u).toFixed(1)}px, ${(-46 * u).toFixed(1)}px)`;
      el.style.opacity = (u < 0.15 ? (u / 0.15) * 0.9 : 0.9 * (1 - (u - 0.15) / 0.85)).toFixed(2);
    }
  }

  setState(s: CharacterState): void {
    this.state = s;
    if (s === 'speaking') this.showBubble();
    this.renderStatus();
  }

  setServiceStatus(st: ServiceStatus): void {
    this.flags.sidecarDown = st.sidecar === 'down';
    this.flags.voicevoxDown = st.voicevox !== 'ok';
    this.renderStatus();
  }

  setMuted(muted: boolean, micOff: boolean, voiceOn = false): void {
    this.flags.muted = muted;
    this.flags.micOff = micOff;
    this.flags.voiceOn = voiceOn && !micOff;
    this.renderStatus();
  }

  setMicSpeech(on: boolean): void {
    this.micSpeech = on;
    this.renderStatus();
  }

  private renderStatus(): void {
    const parts: string[] = [];
    const s = this.state;
    if (s === 'listening') parts.push(`<span class="chip listening ${this.micSpeech ? 'active' : ''}">${icon('mic')}${STATE_LABEL[s]}</span>`);
    else if (s === 'thinking') parts.push(`<span class="chip thinking">${icon('dots')}${STATE_LABEL[s]}</span>`);
    else if (s === 'acting') parts.push(`<span class="chip acting">${icon('gear')}${STATE_LABEL[s]}</span>`);
    else if (s === 'awaiting') parts.push(`<span class="chip awaiting">${icon('hand')}${STATE_LABEL[s]}</span>`);
    else if (s === 'sleeping') parts.push(`<span class="chip sleeping">${icon('moon')}${STATE_LABEL[s]}</span>`);
    // 常時音声認識（ウェイクワード待ち受け）中は、状態に関わらず表示し続ける
    if (this.flags.voiceOn && s !== 'listening' && s !== 'sleeping')
      parts.push(`<span class="chip voice-on" title="音声会話モード：声で話しかけられます"><span class="rec"></span>音声認識中</span>`);
    if (this.flags.muted) parts.push(`<span class="chip mini" title="ミュート中">${icon('mute')}</span>`);
    if (this.flags.micOff) parts.push(`<span class="chip mini" title="マイクOFF">${icon('micOff')}</span>`);
    if (this.flags.voicevoxDown) parts.push(`<span class="chip mini warn" title="VOICEVOXに接続できません（Windows標準音声で代替）">${icon('warn')}</span>`);
    this.status.innerHTML = parts.join('');
    this.status.style.display = parts.length ? '' : 'none';
  }

  // ---------------- input ----------------

  openInput(): void {
    this.inputBar.classList.remove('hidden');
    this.cb.inputPanel(true);
    requestAnimationFrame(() => this.input.focus());
  }

  get inputOpen(): boolean {
    return !this.inputBar.classList.contains('hidden');
  }

  private closeInput(clear: boolean): void {
    if (clear) this.input.value = '';
    this.inputBar.classList.add('hidden');
    this.cb.inputPanel(false);
  }

  private submit(): void {
    const t = this.input.value.trim();
    if (!t) return;
    this.cb.submitText(t);
    this.input.value = '';
    this.autoSize();
  }

  private autoSize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }

  // ---------------- approval (SC-02) ----------------

  showApproval(req: ApprovalRequest): void {
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    const lvl = req.level === 'L2' ? 'l2' : 'l1';
    const targets = req.targets.map((t) => `<li>${escapeHtml(t)}</li>`).join('');
    this.approval.className = `approval ${lvl}`;
    this.approval.innerHTML = `
      <div class="ap-head"><span class="ap-level">${req.level === 'L2' ? '要承認' : '確認'}</span><span class="ap-title">${escapeHtml(req.title)}</span></div>
      ${req.summary ? `<div class="ap-summary">${escapeHtml(req.summary)}</div>` : ''}
      ${targets ? `<ul class="ap-targets">${targets}</ul>` : ''}
      <div class="ap-note">${req.voiceAllowed ? '声で「いいよ」「だめ」でも答えられます' : 'この作業はボタンでのみ許可できます'}</div>
      <div class="ap-actions">
        <button class="btn deny">拒否</button>
        ${req.alwaysTodayAllowed ? '<button class="btn always">今日は常に許可</button>' : ''}
        <button class="btn approve">許可</button>
      </div>
      <div class="ap-timer"><div class="ap-bar"></div></div>`;
    this.approval.querySelector('.deny')!.addEventListener('click', () => this.cb.answer(req.id, 'deny'));
    this.approval.querySelector('.approve')!.addEventListener('click', () => this.cb.answer(req.id, 'approve'));
    this.approval.querySelector('.always')?.addEventListener('click', () => this.cb.answer(req.id, 'always_today'));
    const bar = this.approval.querySelector<HTMLElement>('.ap-bar')!;
    const total = Math.max(1, req.expiresAt - Date.now());
    this.approvalTimer = setInterval(() => {
      const left = Math.max(0, req.expiresAt - Date.now());
      bar.style.width = `${(left / total) * 100}%`;
    }, 250);
  }

  hideApproval(): void {
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    this.approval.className = 'approval hidden';
  }

  // ---------------- toasts ----------------

  toast(text: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    const t = el('div', `toast ${kind}`);
    t.textContent = text;
    this.toasts.appendChild(t);
    setTimeout(() => t.classList.add('out'), kind === 'info' ? 3500 : 6000);
    setTimeout(() => t.remove(), kind === 'info' ? 4000 : 6500);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
