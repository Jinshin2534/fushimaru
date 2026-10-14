// 原曲（伴奏入りでもよい）から主旋律＝ガイドメロディを推定する。
// 1) 左右の一致度で「中央に定位した音」を強調（ボーカルはたいてい真ん中）
// 2) 倍音の重み付き和（ハーモニック・サム）で各フレームの基本周波数候補を出す
// 3) 動的計画法で「急に飛ばない」経路を選ぶ → 4) 安定した区間を音符にまとめる
import { fft, hann } from './fft.js';
import { midiToHz } from './pitch.js';

export const ANALYSIS_RATE = 16000;
const N = 2048;
const MIDI_LO = 43; // G2
const MIDI_HI = 84; // C6
const STEP = 0.1; // 候補の刻み（半音）
const HARMONICS = 8;

/**
 * @param {Float32Array} left
 * @param {Float32Array} right 同じ長さ（モノラルなら left と同じ配列を渡す）
 * @param {object} [o]
 * @returns {{hop:number, midi:Float32Array}} midi は無声フレームが NaN
 */
export function extractPitchTrack(left, right, o = {}) {
  const sr = o.sampleRate ?? ANALYSIS_RATE;
  const hop = o.hop ?? 0.02;
  const hopS = Math.round(hop * sr);
  const nFrames = Math.max(0, Math.floor((left.length - N) / hopS) + 1);
  const win = hann(N);
  const mono = left === right;
  const binHz = sr / N;
  const cands = [];
  for (let m = MIDI_LO; m <= MIDI_HI + 1e-9; m += STEP) cands.push(m);
  const nc = cands.length;
  // 候補ごとの倍音ビン位置を前計算
  const hbin = cands.map((m) => {
    const f0 = midiToHz(m);
    const out = [];
    for (let h = 1; h <= HARMONICS; h++) {
      const f = f0 * h;
      if (f > 4000) break;
      out.push([f / binHz, 0.84 ** (h - 1)]);
    }
    return out;
  });
  const lo = Math.floor(80 / binHz);
  const hi = Math.ceil(4200 / binHz);

  const reL = new Float64Array(N);
  const imL = new Float64Array(N);
  const reR = new Float64Array(N);
  const imR = new Float64Array(N);
  const mag = new Float64Array(N / 2);
  const TOP = 5;
  const peaks = []; // frame -> [{m, s}]
  const energy = new Float64Array(nFrames);
  const sal = new Float64Array(nc);

  for (let f = 0; f < nFrames; f++) {
    if (o.onProgress && f % 250 === 0) o.onProgress(f / nFrames);
    const off = f * hopS;
    for (let i = 0; i < N; i++) {
      reL[i] = left[off + i] * win[i];
      imL[i] = 0;
      if (!mono) {
        reR[i] = right[off + i] * win[i];
        imR[i] = 0;
      }
    }
    fft(reL, imL);
    if (!mono) fft(reR, imR);
    let e = 0;
    for (let k = lo; k <= hi; k++) {
      let a;
      if (mono) {
        a = Math.hypot(reL[k], imL[k]);
      } else {
        const cr = reL[k] * reR[k] + imL[k] * imR[k]; // Re(L·conj R)
        const pl = reL[k] * reL[k] + imL[k] * imL[k];
        const pr = reR[k] * reR[k] + imR[k] * imR[k];
        const w = pl + pr > 0 ? Math.max(0, (2 * cr) / (pl + pr)) : 0; // 1=完全に中央
        a = Math.hypot(reL[k] + reR[k], imL[k] + imR[k]) * 0.5 * w * w;
      }
      e += a * a;
      mag[k] = Math.log1p(a * 20);
    }
    energy[f] = e;
    for (let c = 0; c < nc; c++) {
      let s = 0;
      for (const [b, wgt] of hbin[c]) {
        const i = Math.floor(b);
        const fr = b - i;
        // 近傍2ビンの大きい方を使う（窓のメインローブ内のずれを吸収）
        const v = Math.max(mag[i] * (1 - fr) + mag[i + 1] * fr, Math.max(mag[i], mag[i + 1]) * 0.9);
        s += v * wgt;
      }
      sal[c] = s;
    }
    const pk = [];
    for (let c = 1; c < nc - 1; c++) {
      if (sal[c] >= sal[c - 1] && sal[c] > sal[c + 1]) pk.push({ m: cands[c], s: sal[c] });
    }
    pk.sort((a, b) => b.s - a.s);
    peaks.push(pk.slice(0, TOP));
  }

  // 有声判定：エネルギーと顕著度のしきい値（曲全体の分布に対する相対値）
  const top = peaks.map((p) => (p[0] ? p[0].s : 0));
  const sTh = percentile(top, 0.9) * (o.salienceRatio ?? 0.55);
  const eTh = percentile(Array.from(energy), 0.9) * (o.energyRatio ?? 0.03);
  const voiced = top.map((s, f) => s > sTh && energy[f] > eTh);

  // 動的計画法：顕著度 − ジャンプのコスト
  const midi = new Float32Array(nFrames).fill(NaN);
  const JUMP = o.jumpCost ?? 0.12;
  let f = 0;
  while (f < nFrames) {
    if (!voiced[f] || !peaks[f].length) {
      f++;
      continue;
    }
    let g = f;
    while (g < nFrames && voiced[g] && peaks[g].length) g++;
    // 区間 [f, g) を解く
    const score = [];
    const back = [];
    for (let t = f; t < g; t++) {
      const pk = peaks[t];
      const norm = pk[0].s;
      const sc = [];
      const bk = [];
      for (let j = 0; j < pk.length; j++) {
        const local = pk[j].s / norm;
        if (t === f) {
          sc.push(local);
          bk.push(-1);
          continue;
        }
        const prev = peaks[t - 1];
        let best = -Infinity;
        let arg = 0;
        for (let i = 0; i < prev.length; i++) {
          const jump = Math.min(Math.abs(pk[j].m - prev[i].m), 12);
          const v = score[t - 1 - f][i] - JUMP * jump * (jump > 0.6 ? 1 : 0.2);
          if (v > best) {
            best = v;
            arg = i;
          }
        }
        sc.push(best + local);
        bk.push(arg);
      }
      score.push(sc);
      back.push(bk);
    }
    let j = score[score.length - 1].indexOf(Math.max(...score[score.length - 1]));
    for (let t = g - 1; t >= f; t--) {
      midi[t] = peaks[t][j].m;
      j = back[t - f][j];
    }
    f = g;
  }
  // t0: フレーム i の時刻は t0 + i*hop（窓の中央）
  return { hop, t0: N / 2 / sr, midi, energy: Float32Array.from(energy) };
}

/** 同じ高さの連続音の「言い直し」を、中央成分の音量の谷で見つける */
export function findDips(energy, { radius = 6, ratio = 0.7 } = {}) {
  const dips = new Uint8Array(energy.length);
  for (let i = 1; i < energy.length - 1; i++) {
    if (!(energy[i] <= energy[i - 1] && energy[i] <= energy[i + 1])) continue;
    let l = 0;
    let r = 0;
    for (let k = Math.max(0, i - radius); k < i; k++) l = Math.max(l, energy[k]);
    for (let k = i + 1; k <= Math.min(energy.length - 1, i + radius); k++) r = Math.max(r, energy[k]);
    if (energy[i] < ratio * Math.min(l, r)) dips[i] = 1;
  }
  return dips;
}

/**
 * 推定ピッチ列を音符（{start,end,midi}）にまとめる。
 * 「直前の区間の中央値から ±0.7 半音以内なら同じ音」として伸ばす。
 */
export function toNotes(track, { minDur = 0.1, tol = 0.7, gap = 0.06 } = {}) {
  const { hop, midi } = track;
  const t0 = track.t0 ?? 0;
  const dips = track.energy ? findDips(track.energy) : null;
  const notes = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.vals.length * hop >= minDur) {
      const s = [...cur.vals].sort((a, b) => a - b);
      notes.push({ start: t0 + cur.start * hop, end: t0 + (cur.end + 1) * hop, midi: Math.round(s[s.length >> 1]) });
    }
    cur = null;
  };
  for (let i = 0; i < midi.length; i++) {
    const m = midi[i];
    if (cur && dips && dips[i]) flush();
    if (Number.isNaN(m)) {
      if (cur && (i - cur.end) * hop > gap) flush();
      continue;
    }
    if (cur) {
      const s = cur.vals.slice(-8).sort((a, b) => a - b);
      const med = s[s.length >> 1];
      if (Math.abs(m - med) <= tol) {
        cur.vals.push(m);
        cur.end = i;
        continue;
      }
      flush();
    }
    cur = { start: i, end: i, vals: [m] };
  }
  flush();
  // 同じ高さで隙間がごく短い音符は1つに
  const merged = [];
  for (const n of notes) {
    const p = merged[merged.length - 1];
    if (p && p.midi === n.midi && n.start - p.end <= gap && !(dips && hasDip(dips, p.end - t0, n.start - t0, hop))) p.end = n.end;
    else merged.push({ ...n });
  }
  return merged;
}

function hasDip(dips, t0, t1, hop) {
  for (let i = Math.floor(t0 / hop) - 1; i <= Math.ceil(t1 / hop) + 1; i++) if (dips[i]) return true;
  return false;
}

export function percentile(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
