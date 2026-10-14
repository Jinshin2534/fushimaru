import { describe, it, expect } from 'vitest';
import { scoreSinging, findLatency, makeSampler, detectVibrato, pitchFrameScore } from '../src/lib/score.js';
import { demoNotes } from '../src/lib/demo.js';
import { sing } from './helpers/sing.js';

const notes = demoNotes();
const score = (o) => scoreSinging(notes, sing(notes, o));

describe('pitchFrameScore', () => {
  it('0.5半音以内は満点、1.3半音で0', () => {
    expect(pitchFrameScore(0.3)).toBe(1);
    expect(pitchFrameScore(0.9)).toBeCloseTo(0.5);
    expect(pitchFrameScore(2)).toBe(0);
  });
});

describe('採点の公平性', () => {
  const good = score({ jitter: 0.1, dynamics: 5, vibrato: { rate: 5.5, depth: 0.25 } });

  it('上手な歌は90点以上', () => {
    expect(good.total).toBeGreaterThan(90);
    expect(good.stats.hits).toBe(notes.length);
  });

  it('1オクターブ下で歌っても同じ点', () => {
    const low = score({ jitter: 0.1, dynamics: 5, vibrato: { rate: 5.5, depth: 0.25 }, octave: -1 });
    expect(low.total).toBeCloseTo(good.total, 1);
  });

  it('無音は0点', () => {
    const r = scoreSinging(notes, []);
    expect(r.total).toBe(0);
    const s = score({ dropout: 1 });
    expect(s.total).toBe(0);
  });

  it('でたらめな声は30点未満（音量や揺れで点を稼げない）', () => {
    const r = score({ random: true, dynamics: 12 });
    expect(r.total).toBeLessThan(30);
  });

  it('全体が半音ずれ続けると大きく減点、1全音なら低得点', () => {
    const semi = score({ shift: 1 });
    const whole = score({ shift: 2 });
    expect(semi.total).toBeLessThan(55);
    expect(whole.total).toBeLessThan(25);
  });

  it('機器の遅れ0.2秒は自動で補正され、点が変わらない', () => {
    const base = score({ jitter: 0.1 });
    const late = score({ jitter: 0.1, delay: 0.2 });
    expect(late.latency).toBeCloseTo(0.2, 1);
    expect(Math.abs(late.total - base.total)).toBeLessThan(1.5);
  });

  it('上手さの順に点が並ぶ', () => {
    const a = score({ jitter: 0.1 });
    const b = score({ jitter: 0.1, wrongNotes: 0.2 });
    const c = score({ jitter: 0.1, wrongNotes: 0.5 });
    const d = score({ random: true });
    expect(a.total).toBeGreaterThan(b.total);
    expect(b.total).toBeGreaterThan(c.total);
    expect(c.total).toBeGreaterThan(d.total);
  });

  it('半分だけ歌うと音程点もほぼ半分', () => {
    const r = score({ dropout: 0.5, seed: 3 });
    expect(r.pitch).toBeGreaterThan(0.3);
    expect(r.pitch).toBeLessThan(0.7);
  });

  it('歌い出しがばらつくとリズムが下がる', () => {
    const tight = score({ jitter: 0.1 });
    const loose = score({ jitter: 0.1, onsetJitter: 0.25 });
    expect(loose.rhythm).toBeLessThan(tight.rhythm - 0.15);
  });

  it('伸ばす音がふらつくと安定性が下がる', () => {
    const steady = score({ jitter: 0.05 });
    const wobbly = score({ jitter: 0.05, drift: 0.45 });
    expect(wobbly.stability).toBeLessThan(steady.stability - 0.2);
  });

  it('ビブラートは安定性を下げず、回数として数える', () => {
    const plain = score({ jitter: 0.05 });
    const vib = score({ jitter: 0.05, vibrato: { rate: 5.5, depth: 0.3 } });
    expect(vib.stats.vibrato).toBeGreaterThan(0);
    expect(plain.stats.vibrato).toBe(0);
    expect(vib.stability).toBeGreaterThan(plain.stability - 0.1);
    expect(vib.expression).toBeGreaterThan(plain.expression);
  });

  it('抑揚があると表現力が上がる', () => {
    expect(score({ dynamics: 6 }).expression).toBeGreaterThan(score({ dynamics: 0 }).expression);
  });

  it('しゃくりを数える', () => {
    expect(score({ scoop: true }).stats.shakuri).toBeGreaterThan(5);
    expect(score({}).stats.shakuri).toBe(0);
  });

  it('低め/高めの傾向をコメントする', () => {
    expect(score({ shift: -0.3 }).comments.join()).toContain('低め');
    expect(score({ shift: 0.3 }).comments.join()).toContain('高め');
  });

  it('区間指定：from/to の外の音符は採点しない', () => {
    const half = notes[Math.floor(notes.length / 2)].start;
    const user = sing(notes.filter((n) => n.start < half));
    const r = scoreSinging(notes, user, { to: half });
    expect(r.total).toBeGreaterThan(85);
    expect(r.stats.notes).toBeLessThan(notes.length);
  });
});

describe('部品', () => {
  it('findLatency は遅れを当てる', () => {
    const s = makeSampler(sing(notes, { delay: 0.12 }));
    expect(findLatency(notes, s)).toBeCloseTo(0.12, 1);
  });
  it('detectVibrato は 5Hz±40セントを検出し、まっすぐな音は検出しない', () => {
    const vib = Array.from({ length: 60 }, (_, i) => 40 * Math.sin(2 * Math.PI * 5 * i * 0.02));
    expect(detectVibrato(vib)).not.toBeNull();
    expect(detectVibrato(new Array(60).fill(3))).toBeNull();
  });
});
