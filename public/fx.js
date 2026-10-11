// 共用的音訊鏈:一個 AudioContext,讓「均衡器」和「動畫用的分析器」用同一條線路。
//   audio → 低音 → 中音 → 高音 → 低通(夜間用)→ 壓縮器(夜間用)→ 補償音量 → 分析器 → 喇叭
// createMediaElementSource 一個 <audio> 只能建一次,所以統一由這裡建,vis.js 向這裡要分析器。
(function () {
  // 情境預設。bass / mid / treble 單位是 dB;night 另外加上低通與壓縮(讓大小聲差距變小,睡前不被突然的聲音吵到)
  const PRESETS = {
    flat: { bass: 0, mid: 0, treble: 0, night: false },
    night: { bass: -2, mid: 0, treble: -5, night: true },
    clarity: { bass: -2, mid: 4, treble: 2, night: false },
    car: { bass: 6, mid: -1, treble: 3, night: false },
  };

  let audio = null, ctx = null, g = null;
  let cur = { preset: 'flat', ...PRESETS.flat };

  function build(el) {
    audio = el;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(audio);
    const shelf = (type, f) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; return n; };
    const low = shelf('lowshelf', 110);
    const mid = shelf('peaking', 1400); mid.Q.value = 0.8;
    const high = shelf('highshelf', 7000);
    const lp = shelf('lowpass', 22000); lp.Q.value = 0.5;
    const comp = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.82;
    src.connect(low); low.connect(mid); mid.connect(high); high.connect(lp); lp.connect(comp); comp.connect(makeup); makeup.connect(analyser); analyser.connect(ctx.destination);
    g = { low, mid, high, lp, comp, makeup, analyser };
    apply();
  }

  function apply() {
    if (!g) return;
    const t = ctx.currentTime;
    g.low.gain.setTargetAtTime(cur.bass, t, 0.03);
    g.mid.gain.setTargetAtTime(cur.mid, t, 0.03);
    g.high.gain.setTargetAtTime(cur.treble, t, 0.03);
    g.lp.frequency.setTargetAtTime(cur.night ? 7000 : 22000, t, 0.05);
    // 壓縮器沒開時 ratio = 1、門檻 0 dB,等於什麼都不做
    g.comp.threshold.setValueAtTime(cur.night ? -32 : 0, t);
    g.comp.knee.setValueAtTime(cur.night ? 20 : 0, t);
    g.comp.ratio.setValueAtTime(cur.night ? 4 : 1, t);
    g.comp.attack.setValueAtTime(0.01, t);
    g.comp.release.setValueAtTime(0.25, t);
    g.makeup.gain.setTargetAtTime(cur.night ? 1.9 : 1, t, 0.05);
  }

  const RadioAudio = {
    presets: PRESETS,
    /** 建立(或取回)音訊鏈。必須在使用者操作(按鍵、點擊)之後呼叫,瀏覽器才允許啟動 AudioContext。 */
    ensure(el) {
      if (!g) {
        try { build(el); } catch (e) { ctx = null; g = null; return null; }
      }
      if (ctx.state === 'suspended') ctx.resume();
      return { ctx, analyser: g.analyser };
    },
    get eq() { return { ...cur }; },
    /** 套用預設名稱,或自訂的 { bass, mid, treble }(自訂時夜間處理關閉) */
    setEq(next) {
      cur = typeof next === 'string'
        ? { preset: next, ...(PRESETS[next] || PRESETS.flat) }
        : { preset: 'custom', night: false, bass: next.bass, mid: next.mid, treble: next.treble };
      apply();
      return { ...cur };
    },
  };

  window.RadioAudio = RadioAudio;
})();
