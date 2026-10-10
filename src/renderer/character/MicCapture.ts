// Microphone → 16 kHz mono Int16 frames (~100 ms) → main → sidecar (spec 2.4 マイク音声の経路, 5.6).
export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private active = false;
  level = 0;

  constructor(private readonly onFrame: (pcm: ArrayBuffer) => void) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      if (!this.stream) {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      }
      if (!this.ctx) {
        this.ctx = new AudioContext();
        await this.ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url).href);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'mic-downsampler', { processorOptions: { targetRate: 16000, frameMs: 100 } });
      this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
        this.level = e.data.level;
        if (this.active) this.onFrame(e.data.pcm);
      };
      this.source.connect(this.node);
      if (!this.active) this.stop();
    } catch (e) {
      this.active = false;
      throw e;
    }
  }

  stop(): void {
    this.active = false;
    this.level = 0;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.node = null;
  }

  /** Release the device entirely (mic disabled in settings). */
  release(): void {
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
