// 音まわりの配線：読み込み・解析用リサンプル・再生（原曲/ボーカルカット/ガイド音）・マイク
import { ANALYSIS_RATE } from '../lib/melody.js';
import { yin, hzToMidi, rms, toDb, midiToHz } from '../lib/pitch.js';
const workletUrl = '/mic-worklet.js'; // public/ に置いて素のまま配信（インライン化させない）

let ctx = null;
export function audioCtx() {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

export async function decodeFile(file) {
  const ab = await file.arrayBuffer();
  return audioCtx().decodeAudioData(ab);
}

export function bufferFromChannels(left, right, sampleRate) {
  const b = audioCtx().createBuffer(2, left.length, sampleRate);
  b.copyToChannel(left, 0);
  b.copyToChannel(right, 1);
  return b;
}

/** 解析用に 16kHz・左右そのままへ落とす */
export async function resampleForAnalysis(buffer) {
  const len = Math.ceil(buffer.duration * ANALYSIS_RATE);
  const off = new OfflineAudioContext(2, len, ANALYSIS_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const r = await off.startRendering();
  const left = r.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? r.getChannelData(1) : left;
  return { left, right };
}

/**
 * 再生。mode: 'original' | 'karaoke'（L−R＝中央の声を消す簡易ボーカルカット）
 * @returns {{startedAt:number, stop:Function, setSongVol:Function, setGuideVol:Function}}
 */
export function play(buffer, { offset = 0, mode = 'original', songVol = 0.8, guideVol = 0, notes = [] } = {}) {
  const c = audioCtx();
  const src = c.createBufferSource();
  src.buffer = buffer;
  const songGain = c.createGain();
  songGain.gain.value = songVol;
  if (mode === 'karaoke' && buffer.numberOfChannels > 1) {
    const split = c.createChannelSplitter(2);
    const inv = c.createGain();
    inv.gain.value = -1;
    const sum = c.createGain();
    src.connect(split);
    split.connect(sum, 0);
    split.connect(inv, 1);
    inv.connect(sum);
    sum.connect(songGain);
  } else {
    src.connect(songGain);
  }
  songGain.connect(c.destination);

  // ガイド音：推定したメロディを柔らかい三角波で鳴らす
  const guideGain = c.createGain();
  guideGain.gain.value = guideVol;
  guideGain.connect(c.destination);
  const startAt = c.currentTime + 0.15;
  const oscs = [];
  for (const n of notes) {
    if (n.end <= offset) continue;
    const t0 = startAt + Math.max(0, n.start - offset);
    const t1 = startAt + (n.end - offset);
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToHz(n.midi);
    const g = c.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.3, t0 + 0.02);
    g.gain.setValueAtTime(0.3, Math.max(t0 + 0.02, t1 - 0.03));
    g.gain.linearRampToValueAtTime(0, t1);
    o.connect(g).connect(guideGain);
    o.start(t0);
    o.stop(t1 + 0.01);
    oscs.push(o);
  }
  src.start(startAt, offset);
  return {
    startedAt: startAt - offset, // 曲の0秒がこの ctx 時刻
    stop() {
      try { src.stop(); } catch {}
      for (const o of oscs) try { o.stop(); } catch {}
      songGain.disconnect();
      guideGain.disconnect();
    },
    setSongVol: (v) => songGain.gain.setTargetAtTime(v, c.currentTime, 0.02),
    setGuideVol: (v) => guideGain.gain.setTargetAtTime(v, c.currentTime, 0.02),
    onEnded: (fn) => (src.onended = fn),
  };
}

/**
 * マイクを開き、ピッチを推定して onFrame({time, midi, db}) を呼ぶ。time は ctx 時刻（窓の中央）
 */
export async function openMic(onFrame, { echoCancellation = true } = {}) {
  const c = audioCtx();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation, noiseSuppression: false, autoGainControl: false },
  });
  await c.audioWorklet.addModule(workletUrl);
  const src = c.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(c, 'mic-tap');
  const mute = c.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(c.destination); // 処理を回すためだけの接続（音は出さない）
  const sr = c.sampleRate;
  const down = sr > 30000 ? 2 : 1;
  const rate = sr / down;
  node.port.onmessage = (e) => {
    const { end, data } = e.data;
    const buf = new Float32Array(data.length / down);
    for (let i = 0; i < buf.length; i++) {
      let s = 0;
      for (let k = 0; k < down; k++) s += data[i * down + k];
      buf[i] = s / down;
    }
    const level = rms(buf);
    const db = toDb(level);
    const p = db > -55 ? yin(buf, rate, { threshold: 0.15 }) : null;
    const midi = p && p.clarity > 0.8 ? hzToMidi(p.hz) : null;
    onFrame({ time: end - data.length / sr / 2, midi, db });
  };
  return {
    close() {
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}
