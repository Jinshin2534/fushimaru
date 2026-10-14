import { describe, it, expect } from 'vitest';
import { extractPitchTrack, toNotes, ANALYSIS_RATE } from '../src/lib/melody.js';
import { synthDemo } from '../src/lib/demo.js';
import { scoreSinging } from '../src/lib/score.js';
import { sing } from './helpers/sing.js';

// 推定したガイドが正解の音符とどれだけ重なるか（時間で重み付け、音高一致のみ）
function overlap(est, truth) {
  let hit = 0;
  let total = 0;
  for (const n of truth) {
    total += n.end - n.start;
    for (const e of est) {
      if (e.midi !== n.midi) continue;
      hit += Math.max(0, Math.min(e.end, n.end) - Math.max(e.start, n.start));
    }
  }
  return hit / total;
}

describe('ガイドメロディの推定', () => {
  const demo = synthDemo({ sampleRate: ANALYSIS_RATE });

  it('伴奏入りのステレオ音源から主旋律を8割以上取り出せる', () => {
    const track = extractPitchTrack(demo.left, demo.right);
    const notes = toNotes(track);
    expect(overlap(notes, demo.notes)).toBeGreaterThan(0.8);
  });

  it('同じ高さの連続音（ドド、ソソ）も別々の音符に分ける', () => {
    const notes = toNotes(extractPitchTrack(demo.left, demo.right));
    expect(notes.length).toBeGreaterThanOrEqual(demo.notes.length - 3);
    expect(notes.length).toBeLessThanOrEqual(demo.notes.length + 3);
  });

  it('モノラル（左右同じ）でも取り出せる', () => {
    const mono = demo.left.map((v, i) => (v + demo.right[i]) / 2);
    const track = extractPitchTrack(mono, mono);
    expect(overlap(toNotes(track), demo.notes)).toBeGreaterThan(0.7);
  });

  it('推定ガイドで採点しても、上手な歌は高得点・ずれた歌は低得点', () => {
    const guide = toNotes(extractPitchTrack(demo.left, demo.right));
    const good = scoreSinging(guide, sing(demo.notes, { jitter: 0.1 }));
    const bad = scoreSinging(guide, sing(demo.notes, { shift: 1.5 }));
    expect(good.total).toBeGreaterThan(85);
    expect(bad.total).toBeLessThan(40);
  });
});

describe('toNotes', () => {
  it('安定した区間を音符にし、短いノイズは捨てる', () => {
    const midi = new Float32Array(100).fill(NaN);
    for (let i = 0; i < 30; i++) midi[i] = 60.1;
    midi[40] = 70; // 単発ノイズ
    for (let i = 50; i < 80; i++) midi[i] = 64 + (i % 2) * 0.2;
    const notes = toNotes({ hop: 0.02, midi });
    expect(notes.map((n) => n.midi)).toEqual([60, 64]);
    expect(notes[0].start).toBe(0);
    expect(notes[1].end).toBeCloseTo(1.6);
  });
});
