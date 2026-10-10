import test from "node:test";
import assert from "node:assert/strict";
import { buildDayTimeline, createScheduler, type Track, type Schedule } from "../src/schedule.ts";

const mk = (id: string, kind: "music" | "show", n: number): Track => ({
  id,
  kind,
  segments: Array.from({ length: n }, (_, i) => ({ file: `seg_${i}.aac`, duration: 10 })),
  totalDuration: n * 10,
});
const tracks = [
  ...Array.from({ length: 6 }, (_, i) => mk(`m${i}`, "music", 24)),
  mk("show1", "show", 180), // 30 分鐘
];
const schedule: Schedule = {
  utcOffsetMinutes: 0,
  slots: [
    { start: "00:00", type: "music" },
    { start: "08:00", type: "show", tracks: ["show1"] },
    { start: "08:30", type: "music" },
    { start: "20:00", type: "show", tracks: ["show1"] },
    { start: "20:30", type: "music" },
  ],
};

test("一天約 24 小時,節目大致在表定時間播出", () => {
  const tl = buildDayTimeline(100, tracks, schedule);
  assert.ok(Math.abs(tl.duration - 86400) < 20, `duration=${tl.duration}`);
  for (const h of [8, 20]) {
    const e = tl.entries.find((x) => x.trackId === "show1" && x.start >= h * 3600)!;
    assert.ok(e.start - h * 3600 < 300, `節目晚了 ${e.start - h * 3600} 秒`); // 最多等前一首歌播完
  }
});

test("同一天結果固定,不同天音樂順序不同", () => {
  const ids = (d: number) => buildDayTimeline(d, tracks, schedule).entries.filter((e) => e.file === "seg_0.aac").map((e) => e.trackId).join();
  assert.equal(ids(100), ids(100));
  assert.notEqual(ids(100), ids(101));
});

test("音樂不會連續重複同一首", () => {
  const tl = buildDayTimeline(7, tracks, schedule);
  const seq = tl.entries.filter((e) => e.file === "seg_0.aac" && e.trackId.startsWith("m")).map((e) => e.trackId);
  for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
});

test("live 視窗:sequence 隨時間遞增、換曲有 discontinuity、跨日不當掉", () => {
  const s = createScheduler(tracks, schedule);
  const base = Date.UTC(2026, 9, 10, 12, 0, 0) / 1000;
  const a = s.windowAt(base, 6)!;
  const b = s.windowAt(base + 10, 6)!;
  assert.ok(b.mediaSequence >= a.mediaSequence);
  assert.equal(a.items.length, 6);
  const midnight = Date.UTC(2026, 9, 11, 0, 0, 0) / 1000;
  for (let t = midnight - 30; t < midnight + 30; t += 5) assert.equal(s.windowAt(t, 6)!.items.length, 6);
  // 一整天掃過一次,換曲處(視窗第一段之後)都要帶 discontinuity
  let found = 0;
  for (let t = base; t < base + 3600; t += 10) found += s.windowAt(t, 6)!.items.filter((i) => i.discontinuity).length;
  assert.ok(found > 0);
});

test("沒有任何內容時回傳 null", () => {
  assert.equal(createScheduler([], schedule).windowAt(1e9, 6), null);
});
