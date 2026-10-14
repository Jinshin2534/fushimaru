// マイク入力を 2048 サンプルの窓にため、1024 サンプルごとに窓と「窓の終わりの時刻」を送る
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.fill = 0;
    this.since = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const n = ch.length;
    this.buf.copyWithin(0, n);
    this.buf.set(ch, 2048 - n);
    this.fill = Math.min(2048, this.fill + n);
    this.since += n;
    if (this.fill === 2048 && this.since >= 1024) {
      this.since = 0;
      // currentTime はこのブロックの先頭。窓の終わり = 先頭 + n/sampleRate
      this.port.postMessage({ end: currentTime + n / sampleRate, data: this.buf.slice() });
    }
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
