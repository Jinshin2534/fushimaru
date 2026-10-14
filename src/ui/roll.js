// ピアノロール（カラオケの音程バー）を canvas に描く
import { foldToward } from '../lib/pitch.js';

export function pitchRange(notes) {
  if (!notes.length) return [55, 75];
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  return [lo - 3, hi + 3];
}

/** 時刻 t に鳴っている（またはいちばん近い）ガイドの音 */
export function noteAt(notes, t) {
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (notes[m].end < t) lo = m + 1;
    else if (notes[m].start > t) hi = m - 1;
    else return notes[m];
  }
  return null;
}

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 260;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{notes:Array, user:Array<{t:number,midi:number|null,ok?:boolean}>, now:number, range:[number,number], span?:[number,number], perNote?:Array}} s
 */
export function drawRoll(canvas, s) {
  const { g, w, h } = fit(canvas);
  const [lo, hi] = s.range;
  const [t0, t1] = s.span ?? [s.now - 2, s.now + 6];
  const x = (t) => ((t - t0) / (t1 - t0)) * w;
  const rowH = h / (hi - lo + 1);
  const y = (m) => h - (m - lo + 0.5) * rowH;

  g.clearRect(0, 0, w, h);
  // 横線（ドの高さを少し濃く）
  for (let m = Math.ceil(lo); m <= hi; m++) {
    g.fillStyle = m % 12 === 0 ? css('--grid-strong') : css('--grid');
    g.fillRect(0, Math.round(y(m) + rowH / 2), w, 1);
  }
  const barH = Math.max(4, Math.min(16, rowH * 0.8));
  const radius = barH / 2;
  const accColor = (acc) => (acc >= 0.6 ? css('--hit') : acc >= 0.3 ? css('--near') : css('--miss'));
  s.notes.forEach((n, i) => {
    if (n.end < t0 || n.start > t1) return;
    const pn = s.perNote?.[i];
    g.fillStyle = pn ? accColor(pn.accuracy) : css('--bar');
    roundRect(g, x(n.start), y(n.midi) - barH / 2, Math.max(2, x(n.end) - x(n.start)), barH, radius);
    g.fill();
  });
  // 歌えた部分をバーの上に塗る
  if (!s.perNote) {
    g.fillStyle = css('--hit');
    for (const u of s.user) {
      if (!u.ok || u.t < t0 || u.t > t1) continue;
      g.fillRect(x(u.t) - 1, y(u.ref) - barH / 2, Math.max(2, (0.025 / (t1 - t0)) * w), barH);
    }
  }
  // 歌い手の音程（ガイドに近いオクターブへ寄せて表示）
  g.fillStyle = css('--voice');
  const dot = s.span ? 1.3 : 2.2; // ふりかえり図では小さく（バーの色が見えるように）
  if (s.span) g.globalAlpha = 0.7;
  for (const u of s.user) {
    if (u.midi == null || u.t < t0 || u.t > t1) continue;
    const ref = u.ref ?? noteAt(s.notes, u.t)?.midi;
    // ガイドの音がない時刻は、音域の真ん中に近いオクターブで表示
    const m = foldToward(u.midi, ref ?? (lo + hi) / 2);
    if (m < lo - 1 || m > hi + 1) continue;
    g.beginPath();
    g.arc(x(u.t), y(m), dot, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  if (!s.span) {
    g.fillStyle = css('--playhead');
    g.fillRect(x(s.now) - 1, 0, 2, h);
  }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
