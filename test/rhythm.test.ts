import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const Rhythm = createRequire(import.meta.url)("../public/rhythm.js");
const beatmap = { beats: [10, 11, 12, 13, 14], strength: [1, 0.5, 0.5, 1, 0.5] };

test("判定:差多少毫秒落在哪一級", () => {
  assert.equal(Rhythm.judge(0), "perfect");
  assert.equal(Rhythm.judge(0.045), "perfect");
  assert.equal(Rhythm.judge(-0.06), "excellent");
  assert.equal(Rhythm.judge(0.09), "excellent");
  assert.equal(Rhythm.judge(0.12), "good");
  assert.equal(Rhythm.judge(-0.141), null);
});

test("剛接上時,前 0.6 秒內的音符不出題", () => {
  const run = Rhythm.createRun(beatmap, 9.8);
  assert.equal(run.notes[0].skip, true); // 10 < 9.8 + 0.6
  assert.equal(run.notes[1].skip, false);
});

test("按到最近的音符,連擊與分數累積", () => {
  const run = Rhythm.createRun(beatmap, 0);
  assert.equal(run.press(10.01).grade, "perfect");
  assert.equal(run.press(11.07).grade, "excellent");
  const r = run.press(12.12);
  assert.equal(r.grade, "good");
  assert.ok(r.delta > 0, "按晚了 delta 為正");
  assert.equal(run.stats.combo, 3);
  assert.equal(run.stats.counts.perfect, 1);
  assert.ok(run.stats.score > 0);
});

test("空按不扣分、也不會重複算同一個音符", () => {
  const run = Rhythm.createRun(beatmap, 0);
  assert.equal(run.press(10.5), null); // 兩拍中間:離最近的拍 0.5 秒
  assert.equal(run.stats.judged, 0);
  assert.ok(run.press(10.0));
  assert.equal(run.press(10.0), null); // 這一拍已經打過
});

test("漏接:超過判定範圍沒按就是 miss,連擊歸零", () => {
  const run = Rhythm.createRun(beatmap, 0);
  run.press(10);
  assert.equal(run.stats.combo, 1);
  const missed = run.update(11.2, true);
  assert.equal(missed.length, 1);
  assert.equal(run.stats.combo, 0);
  assert.equal(run.stats.counts.miss, 1);
});

test("時間跳一大步(暫停後回到直播)跳過的音符不算漏接", () => {
  const run = Rhythm.createRun(beatmap, 0);
  const missed = run.update(13.5, false);
  assert.equal(missed.length, 0);
  assert.equal(run.stats.counts.miss, 0);
  assert.equal(run.press(14.0).grade, "perfect"); // 之後的音符還是正常
});

test("準確率:全 perfect 為 1,漏接拉低", () => {
  const run = Rhythm.createRun(beatmap, 0);
  run.press(10); run.press(11);
  assert.equal(run.stats.accuracy, 1);
  run.update(12.2, true);
  assert.ok(run.stats.accuracy < 1);
});
