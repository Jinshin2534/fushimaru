// 合成の「歌い手」。ガイドの音符から、いろいろな歌い方のピッチ列を作る。
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * @param {Array} notes
 * @param {object} o
 *  shift: 全体の音程ずれ（半音） / jitter: 細かい揺れ（半音） / delay: 遅れ（秒）
 *  vibrato: {rate, depth半音} / octave / onsetJitter: 歌い出しのばらつき（秒）
 *  dropout: 歌わない音の割合 / drift: 伸ばす音でのゆっくりした揺れ（半音）
 *  dynamics: 音量の起伏（dB） / scoop: しゃくり
 */
export function sing(notes, o = {}) {
  const r = rng(o.seed ?? 7);
  const hop = 0.021;
  const end = notes[notes.length - 1].end + 1;
  const out = [];
  const plan = notes.map((n) => ({
    n,
    on: (o.onsetJitter ? (r() * 2 - 1) * o.onsetJitter : 0),
    skip: o.dropout ? r() < o.dropout : false,
    wrong: o.wrongNotes ? (r() < o.wrongNotes ? (r() < 0.5 ? -2 : 2) : 0) : 0,
  }));
  for (let t = 0; t < end; t += hop) {
    const tt = t - (o.delay ?? 0);
    const p = plan.find((x) => tt >= x.n.start + x.on && tt < x.n.end);
    let midi = null;
    if (p && !p.skip) {
      const local = tt - p.n.start - p.on;
      midi = p.n.midi + (o.shift ?? 0) + (o.octave ?? 0) * 12 + p.wrong;
      if (o.jitter) midi += (r() * 2 - 1) * o.jitter;
      if (o.vibrato && local > 0.25) midi += o.vibrato.depth * Math.sin(2 * Math.PI * o.vibrato.rate * local);
      if (o.drift) midi += o.drift * Math.sin(2 * Math.PI * 1.1 * local + p.n.midi);
      if (o.scoop && local < 0.15) midi -= 1 * (1 - local / 0.15);
    }
    if (o.random) midi = r() < 0.7 ? 50 + r() * 24 : null;
    const phrase = Math.sin(t * 0.7);
    out.push({ t, midi, db: midi == null ? -60 : -20 + (o.dynamics ?? 0) * phrase });
  }
  return out;
}
