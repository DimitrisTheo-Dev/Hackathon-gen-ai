// Audio worklet for live transcription (see source.ts): mono float audio in, little-endian int16 PCM out,
// posted in ~85 ms chunks. Plain JavaScript on purpose: it is emitted as its own file and loaded with
// audioWorklet.addModule, so the page's script policy can stay same-origin only (no blob: scripts).
class PcmInt16 extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Int16Array(4096);
    this.n = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel)
      for (let i = 0; i < channel.length; i++) {
        const sample = Math.max(-1, Math.min(1, channel[i]));
        this.chunk[this.n++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        if (this.n === this.chunk.length) {
          this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
          this.chunk = new Int16Array(4096);
          this.n = 0;
        }
      }
    return true;
  }
}
registerProcessor("pcm-int16", PcmInt16);
