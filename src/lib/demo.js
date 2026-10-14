// 内蔵デモ曲：「きらきら星」（フランス民謡・パブリックドメイン）をステレオで合成する。
// ボーカル役のリードは中央、和音は左右に振る＝実際の曲と同じ「声は真ん中」の構図。
import { midiToHz } from './pitch.js';

const C4 = 60;
// [音高(Cからの半音), 拍数]
const MELODY = [
  [0, 1], [0, 1], [7, 1], [7, 1], [9, 1], [9, 1], [7, 2],
  [5, 1], [5, 1], [4, 1], [4, 1], [2, 1], [2, 1], [0, 2],
  [7, 1], [7, 1], [5, 1], [5, 1], [4, 1], [4, 1], [2, 2],
  [7, 1], [7, 1], [5, 1], [5, 1], [4, 1], [4, 1], [2, 2],
  [0, 1], [0, 1], [7, 1], [7, 1], [9, 1], [9, 1], [7, 2],
  [5, 1], [5, 1], [4, 1], [4, 1], [2, 1], [2, 1], [0, 2],
];
// 2拍ごとの和音（ルート、3和音）
const CHORDS = [
  0, 0, // 前奏
  0, 0, 5, 0, 5, 0, 7, 0,
  0, 5, 0, 7, 0, 5, 0, 7,
  0, 0, 5, 0, 5, 0, 7, 0,
].map((r) => [r, r + 4, r + 7]);

export const DEMO_TITLE = 'きらきら星（デモ）';

/** デモ曲の正解の音符列（秒） */
export function demoNotes({ bpm = 100, lead = 2 } = {}) {
  const beat = 60 / bpm;
  let t = lead * beat * 2;
  return MELODY.map(([p, len]) => {
    const n = { start: t, end: t + len * beat * 0.92, midi: C4 + p };
    t += len * beat;
    return n;
  });
}

/** @returns {{left:Float32Array,right:Float32Array,sampleRate:number,notes:Array}} */
export function synthDemo({ sampleRate = 44100, bpm = 100, lead = 2, vibrato = true } = {}) {
  const beat = 60 / bpm;
  const notes = demoNotes({ bpm, lead });
  const dur = notes[notes.length - 1].end + beat * 2;
  const len = Math.ceil(dur * sampleRate);
  const left = new Float32Array(len);
  const right = new Float32Array(len);

  // リード（中央）：倍音多めの声っぽい音＋ゆるいビブラート
  for (const n of notes) {
    const s0 = Math.floor(n.start * sampleRate);
    const s1 = Math.floor(n.end * sampleRate);
    const f = midiToHz(n.midi);
    let ph = 0;
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / sampleRate;
      const env = Math.min(1, t / 0.03) * Math.min(1, (s1 - i) / sampleRate / 0.05);
      const vib = vibrato && t > 0.35 ? 1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t) : 1;
      ph += (2 * Math.PI * f * vib) / sampleRate;
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(ph * h) / (h * 1.3);
      v *= 0.22 * env;
      left[i] += v;
      right[i] += v;
    }
  }
  // 伴奏：和音は左寄り/右寄り、ベースは中央・小さめ
  const barLen = beat * 2;
  CHORDS.forEach((ch, k) => {
    const t0 = k * barLen;
    const s0 = Math.floor(t0 * sampleRate);
    const s1 = Math.min(len, Math.floor((t0 + barLen) * sampleRate));
    ch.forEach((p, idx) => {
      const f = midiToHz(C4 - 12 + p);
      const pan = idx % 2 === 0 ? 0.85 : 0.15; // 左右に振る
      for (let i = s0; i < s1; i++) {
        const t = (i - s0) / sampleRate;
        const env = Math.exp(-t * 1.6) * Math.min(1, t / 0.01);
        const v = 0.08 * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t));
        left[i] += v * pan;
        right[i] += v * (1 - pan);
      }
    });
    const fb = midiToHz(C4 - 24 + ch[0]);
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / sampleRate;
      const v = 0.06 * Math.exp(-t * 2) * Math.sin(2 * Math.PI * fb * t);
      left[i] += v;
      right[i] += v;
    }
  });
  return { left, right, sampleRate, notes };
}
