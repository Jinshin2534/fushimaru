import { synthDemo, DEMO_TITLE } from './lib/demo.js';
import { scoreSinging, WEIGHTS } from './lib/score.js';
import { foldedDiff, midiName, foldToward } from './lib/pitch.js';
import { audioCtx, decodeFile, bufferFromChannels, resampleForAnalysis, play, openMic } from './audio/engine.js';
import { drawRoll, pitchRange, noteAt } from './ui/roll.js';

const $ = (id) => document.getElementById(id);
const state = {
  buffer: null,
  title: '',
  notes: [],
  range: [55, 75],
  singing: null,
  result: null,
  lastUser: [],
  lastFrom: 0,
};

function show(id) {
  for (const s of ['pick', 'analyzing', 'stage', 'result']) $(s).hidden = s !== id;
  window.scrollTo({ top: 0 });
}

const fmt = (t) => `${Math.floor(Math.max(0, t) / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, '0')}`;

// ---------- 1. 曲を選ぶ → 2. 解析 ----------
async function loadBuffer(buffer, title) {
  state.buffer = buffer;
  state.title = title;
  show('analyzing');
  $('prog').style.width = '0%';
  $('progText').textContent = '音源を準備中…';
  const { left, right } = await resampleForAnalysis(buffer);
  const notes = await new Promise((resolve, reject) => {
    const w = new Worker(new URL('./audio/analyze.worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.type === 'progress') {
        $('prog').style.width = `${Math.round(e.data.p * 100)}%`;
        $('progText').textContent = `${Math.round(e.data.p * 100)}%`;
      } else {
        w.terminate();
        resolve(e.data.notes);
      }
    };
    w.onerror = (err) => {
      w.terminate();
      reject(err);
    };
    w.postMessage({ left, right: right === left ? null : right });
  });
  state.notes = notes;
  state.range = pitchRange(notes);
  setupStage();
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await openFile(f);
  e.target.value = '';
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) await openFile(f);
});

async function openFile(f) {
  try {
    const buf = await decodeFile(f);
    await loadBuffer(buf, f.name.replace(/\.[^.]+$/, ''));
  } catch (err) {
    console.error(err);
    show('pick');
    alert('この音源は読み込めませんでした。mp3 / m4a / wav などの音声ファイルを選んでください。');
  }
}

async function loadDemo() {
  const d = synthDemo({ sampleRate: 44100 });
  await loadBuffer(bufferFromChannels(d.left, d.right, d.sampleRate), DEMO_TITLE);
}
$('demo').addEventListener('click', loadDemo);

// ---------- 3. 歌う ----------
function firstNoteTime() {
  return state.notes.length ? Math.max(0, state.notes[0].start - 2) : 0;
}

function setupStage() {
  $('title').textContent = state.title;
  const from = $('from');
  from.max = String(Math.max(1, Math.floor(state.buffer.duration - 5)));
  from.value = String(firstNoteTime());
  updateFrom();
  $('micErr').hidden = true;
  show('stage');
  idleDraw();
}

function updateFrom() {
  $('fromLabel').textContent = fmt(+$('from').value);
  $('clock').textContent = `${fmt(+$('from').value)} / ${fmt(state.buffer.duration)}`;
  idleDraw();
}
$('from').addEventListener('input', updateFrom);

function idleDraw() {
  if (state.singing || $('stage').hidden) return;
  drawRoll($('roll'), { notes: state.notes, user: [], now: +$('from').value + 2, range: state.range });
  if (!state.notes.length) $('liveNote').textContent = 'メロディが見つかりません';
}

$('songVol').addEventListener('input', (e) => state.singing?.player.setSongVol(+e.target.value));
$('guideVol').addEventListener('input', (e) => state.singing?.player.setGuideVol(+e.target.value));
$('change').addEventListener('click', () => {
  stopSinging();
  show('pick');
});

async function startSinging() {
  const c = audioCtx();
  await c.resume();
  $('micErr').hidden = true;
  const from = +$('from').value;
  const user = [];
  const live = []; // 表示用（遅れ補正済みの時刻で持つ）
  const liveLat = (c.outputLatency || 0) + (c.baseLatency || 0) + 0.03;
  let player = null;
  let mic;
  let okCount = 0;
  let inNote = 0;
  try {
    mic = await openMic(
      (fr) => {
        if (!player) return;
        const raw = fr.time - player.startedAt;
        if (raw < from - 0.2) return;
        user.push({ t: raw, midi: fr.midi, db: fr.db });
        const t = raw - liveLat;
        const n = noteAt(state.notes, t);
        const ok = n != null && fr.midi != null && Math.abs(foldedDiff(fr.midi, n.midi)) <= 0.5;
        if (n) {
          inNote++;
          if (ok) okCount++;
        }
        live.push({ t, midi: fr.midi, ref: n?.midi, ok });
        $('level').style.width = `${Math.max(0, Math.min(100, (fr.db + 60) * 2))}%`;
        if (fr.midi != null) $('liveNote').textContent = midiName(n ? foldToward(fr.midi, n.midi) : fr.midi);
        if (inNote) $('liveAcc').textContent = `${Math.round((okCount / inNote) * 100)}%`;
      },
      { echoCancellation: $('echo').checked },
    );
  } catch (err) {
    console.error(err);
    $('micErr').textContent = 'マイクを使えませんでした。ブラウザのマイク許可を確認してください。';
    $('micErr').hidden = false;
    return;
  }
  player = play(state.buffer, {
    offset: from,
    mode: document.querySelector('input[name=mode]:checked').value,
    songVol: +$('songVol').value,
    guideVol: +$('guideVol').value,
    notes: state.notes,
  });
  player.onEnded(() => state.singing && finish());
  state.singing = { player, mic, user, live, from, liveLat };
  $('start').hidden = true;
  $('stop').hidden = false;
  $('liveAcc').textContent = '--';
  const loop = () => {
    if (!state.singing) return;
    const now = c.currentTime - player.startedAt - (c.outputLatency || 0);
    drawRoll($('roll'), { notes: state.notes, user: live, now, range: state.range });
    $('clock').textContent = `${fmt(now)} / ${fmt(state.buffer.duration)}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
$('start').addEventListener('click', startSinging);

function stopSinging() {
  const s = state.singing;
  if (!s) return null;
  state.singing = null;
  s.player.stop();
  s.mic.close();
  $('start').hidden = false;
  $('stop').hidden = true;
  return s;
}

function finish() {
  const s = stopSinging();
  if (!s) return;
  const c = audioCtx();
  const to = Math.min(state.buffer.duration, c.currentTime - s.player.startedAt);
  showResult(s.user, s.from, to);
}
$('stop').addEventListener('click', finish);

// ---------- 4. 結果 ----------
const AXES = [
  ['pitch', '音程'],
  ['stability', '安定性'],
  ['rhythm', 'リズム'],
  ['expression', '表現力'],
];

function rankOf(t) {
  if (t >= 95) return '🏆 神がかり！';
  if (t >= 90) return '✨ プロ級';
  if (t >= 85) return '🎉 かなり上手';
  if (t >= 80) return '👏 上手';
  if (t >= 70) return '🙂 いい感じ';
  if (t >= 50) return '💪 のびしろあり';
  return '🎤 まずはガイド音で練習してみよう';
}

function showResult(user, from, to) {
  const r = scoreSinging(state.notes, user, { from, to });
  state.result = r;
  state.lastUser = user;
  state.lastFrom = from;
  show('result');
  $('axes').innerHTML = AXES.map(
    ([k, label]) => `<div class="axis"><div class="row"><span>${label} <span class="muted small">×${Math.round(WEIGHTS[k] * 100)}%</span></span><b>${Math.round(r[k] * 100)}</b></div><div class="bar"><i style="width:${Math.round(r[k] * 100)}%"></i></div></div>`,
  ).join('');
  const st = r.stats;
  $('stats').innerHTML = [
    ['ヒットした音', `${st.hits}/${st.notes}`],
    ['ロングトーン', `${st.longTones}`],
    ['ビブラート', `${st.vibrato}回`],
    ['しゃくり', `${st.shakuri}回`],
    ['声の抑揚', `${st.dynamicRange.toFixed(1)}dB`],
  ].map(([k, v]) => `<li>${k} <b>${v}</b></li>`).join('');
  $('comments').innerHTML = r.comments.map((c) => `<li>${c}</li>`).join('');
  $('latencyNote').textContent = `機器の遅れを ${Math.round(r.latency * 1000)}ms と推定して補正しました。水色＝合っていた音、黄＝おしい、赤＝外れ。白い点があなたの声です。`;
  const span = r.perNote.length ? [r.perNote[0].start - 0.5, r.perNote[r.perNote.length - 1].end + 0.5] : [from, to];
  const perNote = state.notes.map((n) => r.perNote.find((p) => p.start === n.start && p.midi === n.midi) ?? null);
  drawRoll($('overview'), {
    notes: state.notes,
    perNote: perNote.map((p) => p ?? { accuracy: -1 }),
    user: user.map((u) => ({ t: u.t - r.latency, midi: u.midi })),
    now: span[0],
    span,
    range: state.range,
  });
  countUp(r.total);
  $('rank').textContent = '';
  setTimeout(() => ($('rank').textContent = rankOf(r.total)), 900);
}

let countToken = 0;
function countUp(target) {
  const el = $('total');
  const t0 = performance.now();
  const token = ++countToken;
  const step = () => {
    if (token !== countToken) return;
    const k = Math.min(1, (performance.now() - t0) / 900);
    el.textContent = (target * (1 - (1 - k) ** 3)).toFixed(3);
    if (k < 1) requestAnimationFrame(step);
    else el.textContent = target.toFixed(3);
  };
  requestAnimationFrame(step);
  // rAF が止まる環境（裏タブなど）でも最終値は必ず出す
  setTimeout(() => token === countToken && (el.textContent = target.toFixed(3)), 1000);
}

$('again').addEventListener('click', () => {
  setupStage();
  $('from').value = String(state.lastFrom);
  updateFrom();
});
$('pickAgain').addEventListener('click', () => show('pick'));
window.addEventListener('resize', idleDraw);

// ---------- ヘッドレス検証用 ----------
window.__app = {
  state,
  loadDemo,
  /** マイクの代わりに合成した歌い手で採点する（shift: 半音ずれ, delay: 遅れ秒） */
  simulate({ shift = 0, delay = 0.12, jitter = 0.08 } = {}) {
    const user = [];
    const end = state.notes.at(-1)?.end ?? 0;
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let t = 0; t < end + 1; t += 0.021) {
      const n = noteAt(state.notes, t - delay);
      user.push({ t, midi: n ? n.midi + shift + rnd() * jitter : null, db: n ? -20 + 5 * Math.sin(t) : -60 });
    }
    showResult(user, 0, end + 1);
    return state.result;
  },
};
