// 音高まわりの純粋関数。音高は MIDI ノート番号（小数可、A4=69）で扱う。
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

const NAMES = ['ド', 'ド#', 'レ', 'レ#', 'ミ', 'ファ', 'ファ#', 'ソ', 'ソ#', 'ラ', 'ラ#', 'シ'];
export function midiName(m) {
  const r = Math.round(m);
  return `${NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

// オクターブ違いを同一視した音程差（半音、-6〜+6）。カラオケ採点の流儀：1オクターブ下で歌っても正解。
export function foldedDiff(user, ref) {
  return ((((user - ref + 6) % 12) + 12) % 12) - 6;
}

// ref に最も近いオクターブへ user を寄せた値（表示用）
export function foldToward(user, ref) {
  return ref + foldedDiff(user, ref);
}

export function rms(buf) {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

export const toDb = (x) => 20 * Math.log10(Math.max(x, 1e-9));

/**
 * YIN による単音ピッチ推定。声（単音）向け。
 * @returns {{hz:number, clarity:number}|null} clarity は 1-最小差分（1に近いほど周期的）
 */
export function yin(buf, sampleRate, { fmin = 70, fmax = 1100, threshold = 0.15 } = {}) {
  const tauMin = Math.max(2, Math.floor(sampleRate / fmax));
  const tauMax = Math.min(Math.floor(sampleRate / fmin), Math.floor(buf.length / 2));
  const w = buf.length - tauMax;
  if (tauMax <= tauMin || w <= 0) return null;
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0;
    for (let i = 0; i < w; i++) {
      const x = buf[i] - buf[i + tau];
      s += x * x;
    }
    d[tau] = s;
  }
  // 累積平均正規化差分
  const cmnd = new Float64Array(tauMax + 1);
  cmnd[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    cmnd[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // 放物線補間
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1];
    const den = a + c - 2 * b;
    if (den !== 0) better = tau + (a - c) / (2 * den);
  }
  return { hz: sampleRate / better, clarity: 1 - cmnd[tau] };
}

/** 長さ n の中央値フィルタ（null は無視、全部 null なら null） */
export function medianSmooth(values, n = 5) {
  const h = Math.floor(n / 2);
  return values.map((v, i) => {
    if (v == null) return null;
    const win = [];
    for (let j = i - h; j <= i + h; j++) if (values[j] != null) win.push(values[j]);
    win.sort((a, b) => a - b);
    return win[(win.length - 1) >> 1];
  });
}
