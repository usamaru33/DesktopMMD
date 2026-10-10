// AudioWorklet: downsample the mic to 16 kHz mono Int16 and post ~100 ms frames.
class MicDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.target = o.targetRate || 16000;
    this.ratio = sampleRate / this.target;
    this.frameLen = Math.round((this.target * (o.frameMs || 100)) / 1000);
    this.buf = new Int16Array(this.frameLen);
    this.n = 0;
    this.pos = 0; // fractional read position into the input stream
    this.acc = 0;
    this.accN = 0;
    this.peak = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // simple box-filter decimation (averaging) — adequate for speech recognition
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        const s = Math.max(-1, Math.min(1, v));
        this.peak = Math.max(this.peak, Math.abs(s));
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.frameLen) {
          const out = this.buf.slice(0);
          this.port.postMessage({ pcm: out.buffer, level: this.peak }, [out.buffer]);
          this.n = 0;
          this.peak = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('mic-downsampler', MicDownsampler);
