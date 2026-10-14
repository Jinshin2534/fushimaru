// 採点の本体。入力はガイドの音符列と、歌い手のピッチ列（{t, midi|null, db}）。
// 観点は家庭用カラオケと同じ4つ：音程・安定性・リズム・表現力。
// 原則：
//  - オクターブ違いは正解扱い（男女でキーが違っても歌える）
//  - 機器の遅れ（マイク/スピーカー）は全体を一定ずらして最もよく合う位置を探して補正する
//  - 音程が合っていない歌に、安定性・リズム・表現力だけで点を与えない（音程ゲート）
import { foldedDiff } from './pitch.js';

const GRID = 0.02;
export const WEIGHTS = { pitch: 0.6, stability: 0.15, rhythm: 0.15, expression: 0.1 };

const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** ずれ d（半音・絶対値）→ 0..1。0.5半音以内は満点、1.3半音で0 */
export const pitchFrameScore = (d) => clamp01((1.3 - d) / 0.8);

/** 歌い手のピッチ列を時刻 t で引く（最近傍、±0.035秒以内） */
export function makeSampler(user) {
  const ts = user.map((u) => u.t);
  return (t) => {
    let lo = 0;
    let hi = ts.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    if (lo > 0 && Math.abs(ts[lo - 1] - t) < Math.abs(ts[lo] - t)) best = lo - 1;
    if (Math.abs(ts[best] - t) > 0.035) return null;
    return user[best];
  };
}

const voicedMidi = (u) => (u && u.midi != null && !Number.isNaN(u.midi) ? u.midi : null);

function pitchTotal(notes, sample, offset) {
  let s = 0;
  for (const n of notes) {
    for (let t = n.start + 0.06; t < n.end; t += GRID) {
      const m = voicedMidi(sample(t + offset));
      if (m != null) s += pitchFrameScore(Math.abs(foldedDiff(m, n.midi)));
    }
  }
  return s;
}

/** 機器の遅れを推定：-0.2〜+0.45秒（Bluetoothイヤホンの遅れも入る幅。広げすぎると1拍ずらしで別の音に合ってしまう）の範囲で音程の一致が最大になるずらし量 */
export function findLatency(notes, sample, { min = -0.2, max = 0.45, step = 0.01 } = {}) {
  const vals = [];
  for (let o = min; o <= max + 1e-9; o += step) vals.push([o, pitchTotal(notes, sample, o)]);
  const top = Math.max(...vals.map((v) => v[1]));
  // 一致度がほぼ最大の「台地」の真ん中を採る（端を採ると片側に寄る）
  const plateau = vals.filter((v) => v[1] >= top * 0.995);
  const best = plateau[Math.floor(plateau.length / 2)][0];
  return Math.round(best * 1000) / 1000;
}

function findEntry(n, at) {
  const near = (m, tol) => m != null && Math.abs(foldedDiff(m, n.midi)) <= tol;
  let best = null;
  let prev = voicedMidi(at(n.start - 0.3 - GRID / 2));
  for (let t = n.start - 0.3; t <= Math.min(n.end, n.start + 0.3); t += GRID / 2) {
    const m = voicedMidi(at(t));
    const fromSilence = prev == null && near(m, 2.5);
    const fromOther = prev != null && !near(prev, 0.7) && near(m, 0.7);
    if (fromSilence || fromOther) {
      if (!best || Math.abs(t - n.start) < Math.abs(best.t - n.start)) best = { t, d: foldedDiff(m, n.midi) };
    }
    prev = m;
  }
  if (best) return best;
  return near(voicedMidi(at(n.start + 0.1)), 0.7) ? 'legato' : null;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
}

function movingAvg(a, w) {
  const h = Math.floor(w / 2);
  return a.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(a.length - 1, i + h); j++) {
      s += a[j];
      c++;
    }
    return s / c;
  });
}

/** 1音ぶんのセント列（ガイドとの差、オクターブ畳み）からビブラートを判定 */
export function detectVibrato(cents, dt = GRID) {
  if (cents.length * dt < 0.4) return null;
  const smooth = movingAvg(cents, Math.round(0.3 / dt));
  const resid = cents.map((c, i) => c - smooth[i]);
  let crossings = 0;
  for (let i = 1; i < resid.length; i++) if (resid[i - 1] < 0 !== resid[i] < 0) crossings++;
  const rate = crossings / 2 / (resid.length * dt);
  const depth = std(resid) * 2 * Math.SQRT2; // 正弦波なら山-谷の幅
  if (rate >= 4 && rate <= 8.5 && depth >= 25 && depth <= 220) return { rate, depth };
  return null;
}

/**
 * @param {{start:number,end:number,midi:number}[]} notes ガイド
 * @param {{t:number,midi:number|null,db:number}[]} user 歌い手（t は曲の頭からの秒）
 * @param {{from?:number,to?:number,latency?:number}} [o]
 */
export function scoreSinging(notes, user, o = {}) {
  const from = o.from ?? -Infinity;
  const to = o.to ?? Infinity;
  const target = notes.filter((n) => n.start >= from - 0.01 && n.end <= to + 0.05 && n.end - n.start >= 0.06);
  const sample = makeSampler(user);
  const empty = {
    total: 0, pitch: 0, stability: 0, rhythm: 0, expression: 0, latency: 0,
    perNote: [], stats: { notes: 0, hits: 0, vibrato: 0, shakuri: 0, longTones: 0, sharpness: 0, dynamicRange: 0 },
    comments: ['採点できる区間がありませんでした'],
  };
  if (!target.length) return empty;

  const latency = o.latency ?? findLatency(target, sample);
  const at = (t) => sample(t + latency);

  let pitchSum = 0;
  let pitchCount = 0;
  let signedSum = 0;
  let signedCount = 0;
  const perNote = [];
  const stabilities = [];
  const rhythms = [];
  let vibrato = 0;
  let shakuri = 0;
  let longTones = 0;

  for (const n of target) {
    let ns = 0;
    let nc = 0;
    const cents = [];
    for (let t = n.start + 0.06; t < n.end; t += GRID) {
      const m = voicedMidi(at(t));
      nc++;
      if (m == null) continue;
      const d = foldedDiff(m, n.midi);
      ns += pitchFrameScore(Math.abs(d));
      if (Math.abs(d) < 1.5) {
        signedSum += d;
        signedCount++;
      }
      cents.push(d * 100);
    }
    pitchSum += ns;
    pitchCount += nc;
    const acc = nc ? ns / nc : 0;
    perNote.push({ ...n, accuracy: acc, hit: acc >= 0.6 });

    // リズム：音の頭の前後0.3秒で「その音に入った」瞬間を探す。
    // 入った＝直前は無声か別の音で、いまはこの音の近く（しゃくりの下からの入りも含む）
    const entry = findEntry(n, at);
    if (entry === 'legato') {
      // 同じ高さの音がつながっていて歌い出しが判別できない → 判定しない
    } else {
      rhythms.push(entry == null ? 0 : clamp01(1 - (Math.abs(entry.t - n.start) - 0.06) / 0.24));
    }

    // しゃくり：下から入って0.25秒以内にその音に合わせる
    if (entry && entry !== 'legato' && entry.d <= -0.3) {
      for (let t = entry.t; t <= entry.t + 0.25; t += GRID / 2) {
        const m = voicedMidi(at(t));
        if (m != null && Math.abs(foldedDiff(m, n.midi)) <= 0.3) {
          shakuri++;
          break;
        }
      }
    }

    // 安定性とビブラート：0.5秒以上の音（ロングトーン）だけで見る
    const dur = n.end - n.start;
    if (dur >= 0.5 && cents.length >= 0.7 * nc && nc > 0) {
      longTones++;
      const mid = cents.slice(Math.floor(cents.length * 0.15), Math.ceil(cents.length * 0.9));
      const smooth = movingAvg(mid, Math.round(0.3 / GRID));
      const drift = std(smooth); // ゆっくりした揺れ（ビブラートは平均で消える）
      const jitter = std(mid.map((c, i) => c - smooth[i]));
      const vib = detectVibrato(mid);
      if (vib) vibrato++;
      // ビブラートは意図した揺れなので、細かい揺れの減点はビブラートでないときだけ
      const shake = vib ? 0 : Math.max(0, jitter - 12);
      stabilities.push(clamp01(1 - (drift - 6) / 40 - shake / 60));
    }
  }

  const pitch = pitchCount ? pitchSum / pitchCount : 0;
  const rhythm = rhythms.length ? rhythms.reduce((a, b) => a + b, 0) / rhythms.length : pitch;
  const stability = stabilities.length ? stabilities.reduce((a, b) => a + b, 0) / stabilities.length : pitch;

  // 抑揚：歌っていた部分の音量（0.3秒平均）の幅
  const lo = target[0].start;
  const hi = target[target.length - 1].end;
  const dbs = user.filter((u) => voicedMidi(u) != null && u.t >= lo + latency && u.t <= hi + latency).map((u) => u.db);
  const smoothDb = movingAvg(dbs, 15).sort((a, b) => a - b);
  const dynamicRange = smoothDb.length > 10
    ? smoothDb[Math.floor(smoothDb.length * 0.9)] - smoothDb[Math.floor(smoothDb.length * 0.1)]
    : 0;
  const expression =
    0.5 * clamp01((dynamicRange - 2) / 8) +
    0.3 * (longTones ? clamp01(vibrato / Math.max(1, longTones * 0.4)) : 0) +
    0.2 * clamp01(shakuri / Math.max(1, target.length * 0.1));

  // 音程ゲート：音程が合っていないのに他の観点で点を稼げないように
  const gate = clamp01(pitch / 0.6);
  const raw =
    WEIGHTS.pitch * pitch +
    gate * (WEIGHTS.stability * stability + WEIGHTS.rhythm * rhythm + WEIGHTS.expression * expression);
  const total = Math.round(raw * 100000) / 1000;

  const hits = perNote.filter((p) => p.hit).length;
  const sharpness = signedCount ? signedSum / signedCount : 0;
  const stats = { notes: target.length, hits, vibrato, shakuri, longTones, sharpness, dynamicRange };
  return {
    total, pitch, stability, rhythm, expression, latency, perNote, stats,
    comments: makeComments({ pitch, stability, rhythm, expression, stats, voiced: signedCount }),
  };
}

export function makeComments({ pitch, stability, rhythm, expression, stats, voiced }) {
  if (!voiced) return ['声が拾えませんでした。マイクの許可と入力音量を確かめてください'];
  const c = [];
  if (pitch >= 0.9) c.push('音程はほぼ完璧です');
  else if (pitch >= 0.7) c.push('音程はおおむね取れています');
  else c.push('音程が外れる箇所が多めです。ガイド音を鳴らして練習してみましょう');
  if (stats.sharpness <= -0.15) c.push(`全体に少し低め（平均${Math.round(stats.sharpness * 100)}セント）。音を上から当てる意識で`);
  else if (stats.sharpness >= 0.15) c.push(`全体に少し高め（平均+${Math.round(stats.sharpness * 100)}セント）。力みすぎに注意`);
  if (stats.longTones && stability < 0.6) c.push('伸ばす音がふらつき気味。お腹で息を支えて');
  if (rhythm < 0.6) c.push('歌い出しのタイミングがずれがち。伴奏の拍を聴いて');
  if (stats.vibrato) c.push(`ビブラート ${stats.vibrato}回`);
  if (stats.shakuri) c.push(`しゃくり ${stats.shakuri}回`);
  if (expression < 0.3) c.push('抑揚が少なめ。サビで声を張ると表現力アップ');
  return c;
}
