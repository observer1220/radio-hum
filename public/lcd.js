// 2003 年 MP3 隨身聽那種 LCD 點陣跑馬燈。用 canvas 畫 5×7 點陣字,沒有外部字型。
//   const lcd = Lcd(canvas, { scroll: true });  lcd.set('72 BPM · KALIMBA AND HARP · RAINY WINDOW');
// 亮點用 --fg、熄滅的點用 --line,所以黑 / 白主題都能用。文字太長才會捲動;偏好「減少動態」的人只顯示開頭、不捲動。
(function () {
  // 每個字 7 列,每列 5 個點(bit 4 = 最左邊)
  const F = {
    A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
    D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
    G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
    J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
    M: [17, 27, 21, 21, 17, 17, 17], N: [17, 25, 21, 19, 17, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
    P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
    S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
    V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 27, 17], X: [17, 17, 10, 4, 10, 17, 17],
    Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
    0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14], 2: [14, 17, 1, 2, 4, 8, 31],
    3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
    6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14],
    9: [14, 17, 17, 15, 1, 2, 12],
    '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], '-': [0, 0, 0, 31, 0, 0, 0],
    '/': [1, 2, 2, 4, 8, 8, 16], "'": [4, 4, 8, 0, 0, 0, 0], '&': [12, 18, 20, 8, 21, 18, 13],
    ':': [0, 12, 12, 0, 12, 12, 0], '+': [0, 4, 4, 31, 4, 4, 0], '(': [2, 4, 8, 8, 8, 4, 2],
    ')': [8, 4, 2, 2, 2, 4, 8], '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4],
    '_': [0, 0, 0, 0, 0, 0, 31], '·': [0, 0, 0, 4, 0, 0, 0], '•': [0, 0, 0, 4, 0, 0, 0],
  };
  const DOT = 3, GAP = 1, PITCH = DOT + GAP, ROWS = 7, PAD = 6;
  const SPACE_COLS = 3, TAIL_COLS = 14; // 字與字之間 1 欄;空白 3 欄;捲完一圈後留的空檔
  const SPEED = 12; // 每秒捲幾欄

  function Lcd(canvas, opts) {
    const g = canvas.getContext('2d');
    const scroll = !opts || opts.scroll !== false;
    let cols = [], offset = 0, w = 0, h = 0, dpr = 1, last = 0, raf = 0, visibleCols = 0, text = '';

    function toCols(str) {
      const out = [];
      for (const ch of str.toUpperCase()) {
        if (ch === ' ') { for (let i = 0; i < SPACE_COLS; i++) out.push(0); continue; }
        const glyph = F[ch];
        if (!glyph) continue; // 沒有的字元(例如中文)直接略過
        for (let c = 4; c >= 0; c--) { let v = 0; for (let r = 0; r < ROWS; r++) if (glyph[r] & (1 << c)) v |= 1 << r; out.push(v); }
        out.push(0);
      }
      return out;
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = ROWS * PITCH - GAP + PAD * 2;
      canvas.style.height = h + 'px';
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      visibleCols = Math.max(1, Math.floor((w - PAD * 2 + GAP) / PITCH));
      draw();
    }

    function draw() {
      const css = getComputedStyle(document.documentElement);
      const on = css.getPropertyValue('--fg').trim() || '#fff';
      const off = css.getPropertyValue('--line').trim() || '#444';
      g.clearRect(0, 0, w, h);
      const loop = scroll && cols.length > visibleCols;
      const total = loop ? cols.length + TAIL_COLS : cols.length;
      const start = Math.floor(offset);
      for (let c = 0; c < visibleCols; c++) {
        let v = 0;
        if (loop) v = (((start + c) % total) < cols.length) ? cols[(start + c) % total] : 0;
        else v = cols[c] || 0;
        for (let r = 0; r < ROWS; r++) {
          g.fillStyle = v & (1 << r) ? on : off;
          g.globalAlpha = v & (1 << r) ? 1 : 0.45;
          g.fillRect(PAD + c * PITCH, PAD + r * PITCH, DOT, DOT);
        }
      }
      g.globalAlpha = 1;
    }

    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !(scroll && cols.length > visibleCols)) { last = now; return; } // 不捲動時也要更新時間,免得之後開始捲動時一次跳很遠
      if (now - last < 1000 / 24) return; // 24fps 夠了,也比較省電
      offset += ((now - last) / 1000) * SPEED;
      last = now;
      draw();
    }

    new ResizeObserver(resize).observe(canvas);
    resize();
    raf = requestAnimationFrame(frame);

    return {
      set(str) {
        if (str === text) return;
        text = str;
        cols = toCols(str);
        offset = 0; last = performance.now();
        draw();
      },
      redraw: draw, // 切換黑 / 白主題後重畫
    };
  }

  window.Lcd = Lcd;
})();
