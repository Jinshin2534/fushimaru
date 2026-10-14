// ガイドメロディの推定は重いので Worker で回す
import { extractPitchTrack, toNotes } from '../lib/melody.js';

self.onmessage = (e) => {
  const { left, right } = e.data;
  const track = extractPitchTrack(left, right ?? left, {
    onProgress: (p) => self.postMessage({ type: 'progress', p }),
  });
  self.postMessage({ type: 'done', track, notes: toNotes(track) });
};
