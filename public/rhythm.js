// 節奏遊戲的規則:判定、計分、連擊。不碰畫面和音訊,所以可以單獨測試(test/rhythm.test.ts)。
//   const run = Rhythm.createRun(beatmap, startPos);   // beatmap = { beats: [秒…], strength: [0~1…] }
//   run.press(pos)   玩家按下,pos = 這一刻聽到的歌曲位置(秒)。回傳 { grade, delta, index } 或 null(附近沒有音符)
//   run.update(pos, normal)   每一幀呼叫。錯過的音符會被標成 miss 並回傳;normal = false 表示時間跳了一大步(暫停後回到直播),跳過的音符不算漏接
(function (root) {
  // 判定範圍(秒):按的時間和拍點差多少
  const WINDOW = { perfect: 0.045, excellent: 0.09, good: 0.14 };
  const POINTS = { perfect: 300, excellent: 200, good: 100, miss: 0 };
  const ACCURACY = { perfect: 1, excellent: 0.7, good: 0.4, miss: 0 };
  const LEAD_IN = 0.6; // 剛開始(或剛接上直播)時,這麼多秒內的音符不出題,免得一進來就被連續漏接

  function judge(deltaSec) {
    const d = Math.abs(deltaSec);
    if (d <= WINDOW.perfect) return 'perfect';
    if (d <= WINDOW.excellent) return 'excellent';
    if (d <= WINDOW.good) return 'good';
    return null;
  }

  function createRun(beatmap, startPos) {
    const notes = beatmap.beats.map((t, i) => ({ t, s: (beatmap.strength && beatmap.strength[i]) || 0.5, result: null, skip: t < startPos + LEAD_IN }));
    const counts = { perfect: 0, excellent: 0, good: 0, miss: 0 };
    let score = 0, combo = 0, maxCombo = 0, accSum = 0, judged = 0;

    function resolve(note, grade) {
      note.result = grade;
      counts[grade]++; judged++; accSum += ACCURACY[grade];
      if (grade === 'miss') combo = 0;
      else { combo++; maxCombo = Math.max(maxCombo, combo); score += Math.round(POINTS[grade] * (1 + Math.min(combo, 50) / 50)); }
    }

    return {
      notes,
      press(pos) {
        let best = -1, bestD = Infinity;
        for (let i = 0; i < notes.length; i++) {
          const n = notes[i];
          if (n.result || n.skip) continue;
          const d = Math.abs(n.t - pos);
          if (d <= WINDOW.good && d < bestD) { best = i; bestD = d; }
          if (n.t - pos > WINDOW.good) break; // 之後的音符更遠
        }
        if (best < 0) return null; // 附近沒有音符:空按不扣分
        const delta = pos - notes[best].t; // 正數 = 按晚了
        const grade = judge(delta);
        resolve(notes[best], grade);
        return { grade, delta, index: best };
      },
      update(pos, normal) {
        const missed = [];
        for (const n of notes) {
          if (n.result || n.skip) continue;
          if (pos - n.t > WINDOW.good) {
            if (normal === false) n.skip = true; // 時間跳過去的,不是玩家漏接
            else { resolve(n, 'miss'); missed.push(n); }
          } else if (n.t > pos) break;
        }
        return missed;
      },
      get stats() {
        return { score, combo, maxCombo, counts: { ...counts }, judged, accuracy: judged ? accSum / judged : 0 };
      },
    };
  }

  const Rhythm = { WINDOW, POINTS, judge, createRun };
  if (typeof module !== 'undefined' && module.exports) module.exports = Rhythm;
  else root.Rhythm = Rhythm;
})(typeof window !== 'undefined' ? window : globalThis);
