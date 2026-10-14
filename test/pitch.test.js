import { describe, it, expect } from 'vitest';
import { yin, hzToMidi, midiToHz, foldedDiff, foldToward, midiName, medianSmooth } from '../src/lib/pitch.js';

const tone = (hz, sr = 24000, n = 1024, harmonics = 5) =>
  Float32Array.from({ length: n }, (_, i) => {
    let v = 0;
    for (let h = 1; h <= harmonics; h++) v += Math.sin((2 * Math.PI * hz * h * i) / sr) / h;
    return v;
  });

describe('yin', () => {
  it.each([110, 196, 261.63, 440, 880])('%dHz の声っぽい音を±5セントで当てる', (hz) => {
    const r = yin(tone(hz), 24000);
    expect(Math.abs(hzToMidi(r.hz) - hzToMidi(hz)) * 100).toBeLessThan(5);
  });
  it('ノイズは無声', () => {
    let s = 3;
    const noise = Float32Array.from({ length: 1024 }, () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1);
    expect(yin(noise, 24000)).toBeNull();
  });
});

describe('音高の変換', () => {
  it('A4=440Hz=69', () => {
    expect(hzToMidi(440)).toBe(69);
    expect(midiToHz(60)).toBeCloseTo(261.63, 1);
    expect(midiName(60)).toBe('ド4');
  });
  it('オクターブを畳んだ差', () => {
    expect(foldedDiff(48, 60)).toBe(0);
    expect(foldedDiff(61, 60)).toBe(1);
    expect(foldedDiff(71, 60)).toBe(-1);
    expect(foldToward(49, 60)).toBe(61);
  });
  it('中央値フィルタは null を保つ', () => {
    expect(medianSmooth([1, 9, 1, null, 2], 3)).toEqual([1, 1, 1, null, 2]);
  });
});
