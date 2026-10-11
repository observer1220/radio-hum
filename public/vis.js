// 隨音樂跳動的視覺化(Web Audio AnalyserNode + Canvas)。
// 用法:const vis = new Visualizer(canvas, audio); vis.setStyle('ring'); vis.setHue(36);
// 樣式:ring 圓環 / bars 柱狀 / wave 波形 / orbs 光球 / off 關閉(只剩背景光暈)
// 色相由頻道主題決定(setHue),切換頻道時會平順過渡,不再自己亂轉色相。
(function () {
  const STYLES = { center: 'Pillars', ring: 'Ring', bars: 'Bars', wave: 'Wave', orbs: 'Orbs', off: 'Off' };
  // 30fps 就夠流暢,也比較省電
  const frameMs = () => 1000 / ({ '1': 15, '2': 8 }[document.documentElement.dataset.perf] || 30);
  const FX = (window.RadioFX = window.RadioFX || { bass: 0, rhythm: 1 });

  function Visualizer(canvas, audio) {
    const g = canvas.getContext('2d');
    let style = 'center';
    let fixedColor = null; // 指定純色(黑白介面用);沒指定就用頻道色相
    let actx = null, analyser = null, freq = null, wave = null;
    let raf = 0, w = 0, h = 0, dpr = 1, bass = 0, lastFrame = 0, lastVar = 0, t0 = performance.now();
    let hue = 280, targetHue = 280;
    let light = false; // 白底:改用深灰色線條
    let bassTargets = [document.documentElement]; // --bass 只寫在這些元素上,避免整頁樣式重算
    const orbs = Array.from({ length: 48 }, (_, i) => ({ a: Math.random() * 6.28, r: 0.15 + Math.random() * 0.35, s: 0.0002 + Math.random() * 0.0006, k: i % 24 }));

    function ensureAudio() {
      if (actx || style === 'off') return;
      try {
        if (window.RadioAudio) {
          // 播放器頁:音訊鏈由 fx.js 統一建立(含均衡器),這裡只拿分析器來畫動畫
          const a = window.RadioAudio.ensure(audio);
          if (!a) return;
          actx = a.ctx; analyser = a.analyser;
        } else {
          actx = new (window.AudioContext || window.webkitAudioContext)();
          const src = actx.createMediaElementSource(audio);
          analyser = actx.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.82;
          src.connect(analyser);
          analyser.connect(actx.destination);
        }
        freq = new Uint8Array(analyser.frequencyBinCount);
        wave = new Uint8Array(analyser.fftSize);
      } catch (e) { actx = null; analyser = null; }
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width); h = Math.max(1, r.height);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    new ResizeObserver(resize).observe(canvas);
    resize();

    // 讀取目前音訊資料;沒有在播(或瀏覽器不允許)時,產生輕微起伏的待機動畫
    function sample(now) {
      const playing = analyser && !audio.paused && actx.state === 'running';
      if (playing) {
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(wave);
      } else {
        const t = (now - t0) / 1000;
        // Uint8Array 遇到負數會繞回 255,所以一定要夾在 0 以上
        for (let i = 0; i < 256; i++) freq[i] = Math.max(0, 26 + 14 * Math.sin(t * 0.8 + i * 0.12) + 8 * Math.sin(t * 1.7 + i * 0.31));
        for (let i = 0; i < 512; i++) wave[i] = 128 + 10 * Math.sin(t * 1.1 + i * 0.04);
      }
      let s = 0;
      for (let i = 0; i < 6; i++) s += freq[i];
      bass += (s / 6 / 255 - bass) * 0.25;
      // 背景光暈與按鈕共用這個變數;每 50ms 寫一次就夠,避免每幀重排
      FX.bass = bass;
      if (now - lastVar > 50) {
        const v = bass.toFixed(3);
        for (const t of bassTargets) t.style.setProperty('--bass', v);
        lastVar = now;
      }
    }

    // 主色用頻道色相;高光與底色各偏移一點,畫面比單色立體
    const col = (l, a, dh) => light
      ? 'hsla(0,0%,' + (14 + (l - 40) * 0.3).toFixed(0) + '%,' + (a == null ? 1 : a) + ')'
      : 'hsla(' + ((hue + (dh || 0) + 360) % 360).toFixed(1) + ',80%,' + l + '%,' + (a == null ? 1 : a) + ')';

    // 置中直條:黑白介面的主視覺。條數依寬度決定(迷你版少一點),中間高、兩側低
    function drawCenter() {
      const n = Math.max(5, Math.min(34, Math.floor(w / 9)));
      const pad = Math.min(18, w * 0.06);
      const bw = Math.min(6, (w - pad * 2) / (n * 1.8));
      const step = (w - pad * 2 - bw) / (n - 1);
      g.fillStyle = fixedColor || (light ? '#111' : '#fff');
      g.globalAlpha = 0.92;
      for (let k = 0; k < n; k++) {
        // 低頻放中間、高頻往兩側:左右對稱的鐘形,像聲音的波形(真實音樂的能量集中在低頻)
        const d = Math.abs(k - (n - 1) / 2) / ((n - 1) / 2);
        const v = freq[Math.floor(Math.pow(d, 1.4) * 150) + 2] / 255;
        const bh = Math.max(bw, v * h * 0.95);
        g.beginPath();
        g.roundRect(pad + k * step, (h - bh) / 2, bw, bh, bw / 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    function drawBars() {
      const n = 40, gap = 4, bw = (w - gap * (n * 2 - 1) - 40) / (n * 2);
      const base = h * 0.82, cx = w / 2;
      for (let i = 0; i < n; i++) {
        const v = freq[Math.floor(Math.pow(i / n, 1.6) * 180) + 2] / 255;
        const bh = Math.max(4, v * h * 0.7);
        const grad = g.createLinearGradient(0, base - bh, 0, base);
        grad.addColorStop(0, col(72, 1, 25)); grad.addColorStop(1, col(48, 0.3));
        g.fillStyle = grad;
        for (const sgn of [-1, 1]) {
          const x = cx + sgn * (i * (bw + gap) + bw / 2 + gap / 2) - bw / 2;
          g.beginPath(); g.roundRect(x, base - bh, bw, bh, 3); g.fill();
        }
      }
    }

    let grooves = null, groovesKey = '';
    function drawGrooves(cx, cy, m) {
      const key = Math.round(m) + '|' + Math.round(hue / 6) + '|' + dpr;
      if (groovesKey !== key) {
        groovesKey = key;
        grooves = document.createElement('canvas');
        grooves.width = grooves.height = Math.ceil(m * dpr);
        const c = grooves.getContext('2d');
        c.scale(dpr, dpr);
        c.lineWidth = 1;
        for (let r = m * 0.12; r < m * 0.49; r += 5) {
          c.strokeStyle = (light ? 'hsla(0,0%,20%,' : 'hsla(' + hue.toFixed(0) + ',60%,70%,') + (0.07 + 0.06 * ((r / 5) % 3 === 0)) + ')';
          c.beginPath(); c.arc(m / 2, m / 2, r, 0, 6.2832); c.stroke();
        }
      }
      g.drawImage(grooves, cx - m / 2, cy - m / 2, m, m);
    }

    function drawRing(now) {
      const cx = w / 2, cy = h / 2, m = Math.min(w, h);
      drawGrooves(cx, cy, m);
      const r0 = m * 0.26 * (1 + bass * 0.3), spokes = 96;
      const rot = now * 0.00007;
      g.lineCap = 'round'; g.lineWidth = Math.max(2, m * 0.012);
      for (let i = 0; i < spokes; i++) {
        const k = i < spokes / 2 ? i : spokes - 1 - i; // 左右對稱
        const v = freq[Math.floor(Math.pow(k / (spokes / 2), 1.5) * 160) + 2] / 255;
        const len = m * 0.025 + v * m * 0.2;
        const a = (i / spokes) * Math.PI * 2 + rot;
        g.strokeStyle = col(58 + v * 18, 0.35 + v * 0.65, v * 30);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len));
        g.stroke();
      }
      const glow = g.createRadialGradient(cx, cy, 0, cx, cy, r0);
      glow.addColorStop(0, col(64, 0.55 + bass * 0.45, 20)); glow.addColorStop(1, col(40, 0));
      g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, r0, 0, 6.2832); g.fill();
    }

    function drawWave(now) {
      const mid = h / 2, n = 160, amp = h * 0.35;
      for (let layer = 0; layer < 3; layer++) {
        g.beginPath();
        for (let i = 0; i <= n; i++) {
          const v = (wave[Math.floor((i / n) * 500)] - 128) / 128;
          const x = (i / n) * w;
          const y = mid + (v * amp * (1 - layer * 0.25)) + Math.sin(now * 0.001 + i * 0.08 + layer) * 6 * layer;
          if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.strokeStyle = col(66 - layer * 8, 0.9 - layer * 0.28, layer * 22);
        g.lineWidth = 3 - layer * 0.6;
        g.stroke();
      }
    }

    function drawOrbs(now) {
      const m = Math.min(w, h);
      for (const o of orbs) {
        const e = freq[o.k * 4 + 2] / 255;
        const a = o.a + now * o.s;
        const rr = (o.r + e * 0.08) * m;
        const x = w / 2 + Math.cos(a) * rr * 1.4, y = h / 2 + Math.sin(a * 1.3) * rr;
        const size = m * (0.012 + e * 0.05) + bass * m * 0.02;
        const grad = g.createRadialGradient(x, y, 0, x, y, size * 3);
        grad.addColorStop(0, col(68, 0.85, (o.k % 3) * 18)); grad.addColorStop(1, col(50, 0));
        g.fillStyle = grad; g.beginPath(); g.arc(x, y, size * 3, 0, 6.2832); g.fill();
      }
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (style === 'off' || document.hidden || now - lastFrame < frameMs()) return;
      lastFrame = now;
      if (!freq) { freq = new Uint8Array(256); wave = new Uint8Array(512); }
      // 色相走最短路徑平順靠近目標(切換頻道時畫面顏色跟著慢慢轉過去)
      let d = ((targetHue - hue + 540) % 360) - 180;
      hue = (hue + d * 0.06 + 360) % 360;
      FX.hue = hue; FX.targetHue = targetHue;
      sample(now);
      g.clearRect(0, 0, w, h);
      if (style === 'bars') drawBars();
      else if (style === 'ring') drawRing(now);
      else if (style === 'wave') drawWave(now);
      else if (style === 'orbs') drawOrbs(now);
      else if (style === 'center') drawCenter();
    }

    audio.addEventListener('play', () => { ensureAudio(); if (actx && actx.state === 'suspended') actx.resume(); });

    return {
      styles: STYLES,
      setBassTargets(list) { bassTargets = list; },
      setLight(v) { light = !!v; groovesKey = ''; },
      setColor(c) { fixedColor = c || null; },
      setHue(v) { targetHue = ((v % 360) + 360) % 360; },
      setStyle(s) {
        if (!STYLES[s]) s = 'center';
        style = s;
        g.clearRect(0, 0, w, h);
        if (s === 'off') { FX.bass = 0; for (const t of bassTargets) t.style.setProperty('--bass', '0'); }
        if (s !== 'off' && !audio.paused) ensureAudio();
      },
      start() { if (!raf) raf = requestAnimationFrame(frame); },
      stop() { cancelAnimationFrame(raf); raf = 0; },
    };
  }

  window.Visualizer = Visualizer;
})();
