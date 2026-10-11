// 節奏遊戲(實驗性):跟著直播電台的歌曲,在拍點上點擊。
// 拍點事先算好(scripts/beats.py → public/beats/<曲目id>.json),這裡只負責:
//   1. 算出「現在聽到的是這首歌的第幾秒」(含喇叭 / 藍牙的延遲補償)
//   2. 畫音符、收點擊、顯示 Perfect / Excellent / Good / Miss、手機震動
// 判定與計分的規則在 rhythm.js。
(function () {
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const audio = new Audio();
  audio.preload = 'none';
  const APPROACH = 1.8;       // 音符從畫面右邊飛到判定圈要幾秒
  const JUMP = 0.3;           // 一幀之間歌曲位置跳超過這麼多秒,就當作暫停 / 重新接上直播,不算漏接
  const state = { channels: [], channel: null, started: false, track: null, curId: null, map: undefined, run: null };

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v); }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無痕模式 */ } },
  };
  const setStatus = (msg, isErr) => { const s = $('status'); s.textContent = msg; s.classList.toggle('err', !!isErr); };

  // ---------- 主題 ----------
  $('btn-theme').addEventListener('click', () => {
    const next = root.classList.contains('dark') ? 'light' : 'dark';
    root.className = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* ignore */ }
    readColors();
  });
  const colors = {};
  function readColors() {
    const css = getComputedStyle(root);
    for (const k of ['fg', 'muted', 'line', 'panel']) colors[k] = css.getPropertyValue('--' + k).trim() || '#888';
  }
  readColors();

  // ---------- 設定:音訊延遲(藍牙耳機常有 150~250 毫秒)、震動 ----------
  let offsetMs = Number(store.get('gameOffset', 0)) || 0;
  $('offset').value = String(offsetMs);
  const showOffset = () => { $('offv').textContent = offsetMs + ' ms'; };
  showOffset();
  $('offset').addEventListener('input', (e) => { offsetMs = Number(e.target.value); store.set('gameOffset', offsetMs); showOffset(); });
  const canVibrate = typeof navigator.vibrate === 'function';
  let vibOn = canVibrate && store.get('gameVib', true) !== false;
  $('vib').checked = vibOn; $('vib').disabled = !canVibrate;
  if (!canVibrate) $('vibrow').title = 'This browser does not support vibration (iPhone / iPad Safari does not).';
  $('vib').addEventListener('change', (e) => { vibOn = e.target.checked; store.set('gameVib', vibOn); if (vibOn) navigator.vibrate(15); });
  const buzz = (grade) => { if (vibOn && canVibrate) navigator.vibrate({ perfect: 18, excellent: 12, good: 8 }[grade] || 0); };

  // ---------- 播放 ----------
  const pretty = (v) => String(v).replace(/\bbpm\b/i, 'BPM');
  const tagLine = (info) => (info && info.tags ? Object.values(info.tags).filter((v) => v && v !== '—').slice(0, 3).map(pretty).join(' · ') : '');
  const player = RadioPlayer(audio, {
    onStatus: (msg) => setStatus(msg, /lost|not support|again/i.test(msg)),
    onTrack: (info, frag) => {
      const cum = []; let acc = 0;
      for (const [, d] of info.segments || []) { cum.push(acc); acc += d; }
      const idx = Math.max(0, (info.segments || []).findIndex((s) => s[0] === frag.file));
      state.track = { info, cum, idx, start: frag.start };
      if (info.id !== state.curId) newSong(info);
    },
    onDenied: () => setStatus('Could not connect to this channel. Please reload the page.', true),
  });
  const showPlaying = (on) => $('card').classList.toggle('paused', !on);
  audio.addEventListener('play', () => showPlaying(true));
  audio.addEventListener('pause', () => showPlaying(false));

  // ---------- 拍點 ----------
  const mapCache = new Map();
  function loadMap(id) {
    if (!mapCache.has(id)) mapCache.set(id, fetch('/beats/' + encodeURIComponent(id) + '.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return mapCache.get(id);
  }
  function finishRun() {
    const run = state.run;
    state.run = null;
    if (!run) return;
    const s = run.stats, c = s.counts;
    if (c.perfect + c.excellent + c.good < 5) return; // 幾乎沒打,就不顯示成績(例如只是聽歌、或剛好接在歌曲結尾)
    $('last').textContent = 'Last song: ' + Math.round(s.accuracy * 100) + '% · Perfect ' + c.perfect + ' · Excellent ' + c.excellent + ' · Good ' + c.good + ' · Miss ' + c.miss + ' · Best combo ' + s.maxCombo;
  }
  function newSong(info) {
    finishRun();
    state.curId = info.id;
    state.map = undefined; // undefined = 載入中,null = 這首歌還沒有節拍圖
    updateHud();
    $('sub').textContent = tagLine(info) || info.title || '';
    loadMap(info.id).then((map) => {
      if (state.curId !== info.id) return;
      state.map = map;
      if (map) { const p = trackPos(); state.run = Rhythm.createRun(map, p == null ? 0 : p); }
      updateHud();
    });
  }

  // ---------- 這首歌現在播到第幾秒 ----------
  // audio.currentTime 在有些瀏覽器更新得很粗,所以自己用 requestAnimationFrame 的時間往前推,再慢慢對齊 currentTime
  let est = 0, lastCt = -1, frame = { perf: 0, pos: null }, lastPos = null;
  let latency = 0;
  function trackPos() {
    const tr = state.track;
    if (!tr) return null;
    const media = est; // 影片 / 串流時間軸上的秒數
    return (tr.cum[tr.idx] || 0) + (media - tr.start) - latency - offsetMs / 1000;
  }
  function step(now, dt) {
    const ct = audio.currentTime;
    if (audio.paused) est = ct;
    else est += dt;
    if (ct !== lastCt) {
      lastCt = ct;
      const err = ct - est;
      est += Math.abs(err) > 0.1 ? err : err * 0.1;
    }
    const pos = trackPos();
    frame = { perf: now, pos };
    return pos;
  }
  const posAt = (perfTime) => (frame.pos == null ? null : frame.pos + (perfTime - frame.perf) / 1000);

  // ---------- 點擊 ----------
  const fx = []; // 浮出來的判定文字
  let flash = 0;
  function press(perfTime) {
    const run = state.run;
    flash = performance.now();
    if (!run || audio.paused) return;
    const pos = posAt(perfTime);
    if (pos == null) return;
    const r = run.press(pos);
    if (!r) return;
    buzz(r.grade);
    fx.push({ grade: r.grade, delta: r.delta, at: performance.now() });
    updateHud();
  }
  const pad = $('pad');
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); pad.classList.add('down'); press(e.timeStamp); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) pad.addEventListener(ev, () => pad.classList.remove('down'));
  $('stage').closest('.stage').addEventListener('pointerdown', (e) => { if ($('overlay').classList.contains('hidden')) { e.preventDefault(); press(e.timeStamp); } });
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== 'Space' && !/^Key[A-Z]$/.test(e.code)) return; // 只認空白鍵和字母鍵,F5、Tab、方向鍵等照常運作
    const tag = document.activeElement.tagName;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    if (/^(BUTTON|A)$/.test(tag) && document.activeElement !== pad) return; // 頻道按鈕、開始鈕:讓空白鍵照原本方式啟動它們
    e.preventDefault();
    press(e.timeStamp);
  });

  function updateHud() {
    const s = state.run ? state.run.stats : null;
    $('score').textContent = s ? s.score : 0;
    $('combo').textContent = s ? s.combo : 0;
    $('acc').textContent = s && s.judged ? Math.round(s.accuracy * 100) + '%' : '--';
  }

  // ---------- 畫面 ----------
  const canvas = $('stage'), g = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  const LABEL = { perfect: 'PERFECT', excellent: 'EXCELLENT', good: 'GOOD', miss: 'MISS' };
  function draw(now, pos) {
    g.clearRect(0, 0, W, H);
    const hitX = W * 0.2, y = H / 2, span = W - hitX - 12;
    g.lineWidth = 1; g.strokeStyle = colors.line; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();

    const run = state.run;
    if (run && pos != null) {
      for (const n of run.notes) {
        const dt = n.t - pos;
        if (dt < -0.5 || dt > APPROACH) continue;
        const x = hitX + (dt / APPROACH) * span;
        const r = 9 + 8 * n.s;
        if (n.result && n.result !== 'miss') continue; // 打中的音符消失
        g.globalAlpha = n.skip ? 0.25 : n.result === 'miss' ? Math.max(0, 0.5 + dt) * 0.5 : 1;
        g.beginPath(); g.arc(x, y, r, 0, 6.2832);
        if (n.result === 'miss') { g.strokeStyle = '#e52d2d'; g.lineWidth = 2; g.stroke(); }
        else if (n.s > 0.7) { g.fillStyle = colors.fg; g.fill(); }
        else { g.strokeStyle = colors.fg; g.lineWidth = 2; g.stroke(); }
      }
      g.globalAlpha = 1;
    }

    // 判定圈:點擊時放大一下
    const pulse = Math.max(0, 1 - (now - flash) / 160);
    g.lineWidth = 2 + pulse * 2; g.strokeStyle = colors.fg;
    g.beginPath(); g.arc(hitX, y, 26 + pulse * 5, 0, 6.2832); g.stroke();

    // 判定文字往上飄、慢慢淡出
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i], p = (now - f.at) / 700;
      if (p >= 1) { fx.splice(i, 1); continue; }
      g.globalAlpha = 1 - p;
      g.textAlign = 'center';
      g.font = '700 ' + (f.grade === 'perfect' ? 17 : 15) + 'px ' + getComputedStyle(root).getPropertyValue('--mono');
      g.fillStyle = f.grade === 'miss' ? '#e52d2d' : f.grade === 'good' ? colors.muted : colors.fg;
      g.fillText(LABEL[f.grade], hitX, y - 42 - p * 18);
      if (f.grade !== 'perfect' && f.grade !== 'miss') {
        g.font = '600 9px ' + getComputedStyle(root).getPropertyValue('--mono');
        g.fillStyle = colors.muted;
        g.fillText(f.delta < 0 ? 'EARLY' : 'LATE', hitX, y - 28 - p * 18);
      }
    }
    g.globalAlpha = 1;

    // 沒有可玩的內容時的提示
    let msg = '';
    if (state.started && !state.track) msg = 'Tuning in…';
    else if (state.track && state.map === undefined) msg = 'Loading beat map…';
    else if (state.track && state.map === null) msg = 'No beat map for this song yet — just listen.';
    else if (audio.paused && state.started) msg = 'Paused';
    if (msg) { g.textAlign = 'center'; g.font = '12px ' + getComputedStyle(root).getPropertyValue('--mono'); g.fillStyle = colors.muted; g.fillText(msg, W / 2 + 20, y + 52); }
  }

  let last = performance.now(), frames = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.25); last = now;
    if (++frames % 30 === 0) {
      const a = window.RadioAudio && window.RadioAudio.ensure(audio);
      if (a) latency = a.ctx.outputLatency || a.ctx.baseLatency || 0;
      if (frames % 120 === 0) readColors();
    }
    const pos = state.started ? step(now, dt) : null;
    if (state.run && pos != null && !audio.paused) {
      const normal = lastPos == null || Math.abs(pos - lastPos - dt) < JUMP;
      if (state.run.update(pos, normal).length) updateHud();
    }
    lastPos = audio.paused ? null : pos;
    draw(now, pos);
  }
  requestAnimationFrame(loop);

  // ---------- 頻道與開始 ----------
  function renderPills() {
    $('channels').replaceChildren(...state.channels.map((c) =>
      el('button', { class: 'pill', type: 'button', 'aria-pressed': String(!!state.channel && state.channel.id === c.id), onclick: () => selectChannel(c) }, c.name)));
  }
  function selectChannel(ch) {
    state.channel = ch;
    state.track = null; state.curId = null; state.map = undefined; finishRun(); updateHud();
    $('title').textContent = ch.name; $('sub').textContent = '';
    renderPills();
    if (!state.started) return;
    if (window.RadioAudio) RadioAudio.ensure(audio);
    player.tune(ch.id, '');
    player.play();
  }
  $('start').addEventListener('click', () => {
    if (!state.channel) return;
    state.started = true;
    $('overlay').classList.add('hidden');
    selectChannel(state.channel); // 在這次點擊裡開始播放,瀏覽器才允許出聲
  });

  async function init() {
    const dir = await (await fetch('/api/channels')).json();
    state.channels = dir.channels;
    // 預設選第一個「單一頻道」(All Day 是各頻道混在一起)
    state.channel = state.channels.find((c) => c.id !== 'all') || state.channels[0];
    if (state.channel) $('title').textContent = state.channel.name;
    renderPills();
  }
  init().catch((e) => setStatus('Failed to load: ' + e.message, true));

  // 除錯與自動測試用:唯讀地看目前的歌曲位置和這一輪的狀態
  window.__rhythm = { get pos() { return frame.pos; }, get run() { return state.run; }, get track() { return state.track; }, press: (t) => press(t == null ? performance.now() : t), get audio() { return audio; } };
})();
