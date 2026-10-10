// Suno 提示詞排列組合管理:自動挑「和已生成過的差最多」的組合,並記錄每一組的結果。
//
//   node scripts/prompts.mjs next <頻道> [數量=5]      產生下一批提示詞(自動避開已用過的組合,並優先補沒用過的選項)
//   node scripts/prompts.mjs mark <kept|rejected|pending> <編號...> [--note "備註"]
//                                                    標記結果(kept=留下、rejected=不要、pending=還沒聽)
//   node scripts/prompts.mjs add <頻道> "<貼上你以前用過的完整提示詞>" [--status kept]
//                                                    補登舊紀錄:會自動比對出各軸用了哪個選項
//   node scripts/prompts.mjs list [頻道] [--status pending]   列出紀錄
//   node scripts/prompts.mjs stats [頻道]             各選項被用了幾次、哪些還沒用過、離目標還差幾首
//   node scripts/prompts.mjs csv                      輸出 CSV(可貼進試算表)
//
// 資料:prompts/axes.json(基底與選項,改這裡就好)、prompts/log.json(使用紀錄,請一併備份)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const AXES_FILE = path.join(ROOT, "prompts", "axes.json");
const LOG_FILE = path.join(ROOT, "prompts", "log.json");
const cfg = JSON.parse(fs.readFileSync(AXES_FILE, "utf8"));
const log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) : [];
const save = () => fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 1) + "\n");

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const fail = (msg) => { console.error(msg); process.exit(1); };
const channelOrDie = (id) => cfg.channels[id] ?? fail(`找不到頻道 "${id}"。可用:${Object.keys(cfg.channels).join(", ")}`);

const buildPrompt = (ch, picks) => [ch.base, ...Object.keys(ch.axes).map((a) => picks[a]).filter(Boolean)].join(", ");
const combos = (axes) =>
  Object.entries(axes).reduce((acc, [axis, opts]) => acc.flatMap((c) => opts.map((o) => ({ ...c, [axis]: o }))), [{}]);
const distance = (axes, a, b) => Object.keys(axes).filter((k) => a[k] !== b[k]).length;
const rand = (n) => Math.floor(Math.random() * n);
const nextId = (channel) =>
  `${channel}-${String(Math.max(0, ...log.filter((r) => r.channel === channel).map((r) => Number(r.id.split("-")[1]))) + 1).padStart(4, "0")}`;

// ---------- next ----------
function cmdNext() {
  const channel = args[0] ?? fail("用法: next <頻道> [數量]");
  const ch = channelOrDie(channel);
  const n = Number(args[1] ?? 5);
  const used = log.filter((r) => r.channel === channel);
  const usedKeys = new Set(used.map((r) => JSON.stringify(r.picks)));
  const pool = combos(ch.axes).filter((c) => !usedKeys.has(JSON.stringify(c)));
  if (pool.length === 0) fail("這個頻道所有組合都用過了,請在 axes.json 增加選項。");

  // 目前各選項已用次數(rejected 不算,因為那組沒產出歌)
  const counts = {};
  for (const r of used.filter((r) => r.status !== "rejected"))
    for (const [a, o] of Object.entries(r.picks)) counts[`${a}|${o}`] = (counts[`${a}|${o}`] ?? 0) + 1;

  const chosen = [];
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    const reference = [...used.map((r) => r.picks), ...chosen];
    let best = null;
    for (const c of pool) {
      if (chosen.includes(c)) continue;
      // 1) 和已有組合「最接近的那一個」差幾個軸,越大越好  2) 偏好用得少的選項  3) 隨機打破平手
      const minDist = reference.length ? Math.min(...reference.map((p) => distance(ch.axes, c, p))) : Object.keys(ch.axes).length;
      const rarity = Object.entries(c).reduce((s, [a, o]) => s + 1 / (1 + (counts[`${a}|${o}`] ?? 0)), 0);
      const score = minDist * 100 + rarity * 10 + Math.random();
      if (!best || score > best.score) best = { c, score, minDist };
    }
    chosen.push(best.c);
    best.c.__minDist = best.minDist;
    for (const [a, o] of Object.entries(best.c)) if (!a.startsWith("__")) counts[`${a}|${o}`] = (counts[`${a}|${o}`] ?? 0) + 1;
  }

  const now = new Date().toISOString();
  for (const c of chosen) {
    const minDist = c.__minDist;
    delete c.__minDist;
    const rec = { id: nextId(channel), channel, picks: c, status: "pending", note: "", createdAt: now };
    log.push(rec);
    const prompt = buildPrompt(ch, c);
    console.log(`\n[${rec.id}]  與最接近的既有組合相差 ${minDist} 個軸 ・ ${prompt.length} 字元`);
    console.log(prompt);
  }
  save();
  console.log(`\nExclude 欄:${cfg.exclude}`);
  console.log(`已記錄為 pending。聽完後用:npm run prompt -- mark kept <編號>  或  mark rejected <編號>`);
  console.log(`剩餘未用組合:${pool.length - chosen.length} / ${combos(ch.axes).length}`);
}

// ---------- mark ----------
function cmdMark() {
  const status = args.shift();
  if (!["kept", "rejected", "pending"].includes(status)) fail("用法: mark <kept|rejected|pending> <編號...> [--note 備註]");
  const note = flag("note");
  if (!args.length) fail("請給編號,例如 chill-0003");
  for (const id of args) {
    const r = log.find((x) => x.id === id);
    if (!r) { console.error(`找不到 ${id}`); continue; }
    r.status = status;
    if (note !== undefined) r.note = note;
    console.log(`${id} → ${status}${r.note ? `(${r.note})` : ""}`);
  }
  save();
}

// ---------- add(補登舊紀錄) ----------
function cmdAdd() {
  const channel = args.shift() ?? fail('用法: add <頻道> "<完整提示詞>" [--status kept]');
  const status = flag("status") ?? "kept";
  const note = flag("note") ?? "補登";
  const ch = channelOrDie(channel);
  const text = (args[0] ?? fail("請貼上提示詞(用引號包起來)")).toLowerCase();
  const picks = {};
  const missing = [];
  for (const [axis, opts] of Object.entries(ch.axes)) {
    const hit = opts.filter((o) => text.includes(o.toLowerCase())).sort((a, b) => b.length - a.length)[0];
    if (hit) picks[axis] = hit; else missing.push(axis);
  }
  if (missing.length) console.log(`⚠ 這些軸在提示詞裡找不到對應選項,已略過:${missing.join("、")}`);
  if (log.some((r) => r.channel === channel && JSON.stringify(r.picks) === JSON.stringify(picks))) fail("這個組合已經在紀錄裡了。");
  const rec = { id: nextId(channel), channel, picks, status, note, createdAt: new Date().toISOString() };
  log.push(rec);
  save();
  console.log(`已補登 ${rec.id}:${Object.values(picks).join(" / ")}`);
}

// ---------- list / stats / csv ----------
function cmdList() {
  const channel = args.find((a) => cfg.channels[a]);
  const status = flag("status");
  const rows = log.filter((r) => (!channel || r.channel === channel) && (!status || r.status === status));
  if (!rows.length) return console.log("沒有紀錄。");
  for (const r of rows) console.log(`${r.id}  ${r.status.padEnd(8)} ${Object.values(r.picks).join(" / ")}${r.note ? `  # ${r.note}` : ""}`);
  console.log(`\n共 ${rows.length} 筆`);
}

function cmdStats() {
  const only = args.find((a) => cfg.channels[a]);
  for (const [id, ch] of Object.entries(cfg.channels)) {
    if (only && only !== id) continue;
    const recs = log.filter((r) => r.channel === id);
    const kept = recs.filter((r) => r.status === "kept").length;
    const pend = recs.filter((r) => r.status === "pending").length;
    const rej = recs.filter((r) => r.status === "rejected").length;
    const total = combos(ch.axes).length;
    console.log(`\n=== ${id} ${ch.name}  留下 ${kept} / 目標 ${ch.target}(待聽 ${pend}、淘汰 ${rej});組合 ${recs.length}/${total} 已用 ===`);
    for (const [axis, opts] of Object.entries(ch.axes)) {
      console.log(`  ${axis}`);
      for (const o of opts) {
        const c = recs.filter((r) => r.status !== "rejected" && r.picks[axis] === o).length;
        console.log(`    ${"█".repeat(Math.min(c, 30)).padEnd(6)} ${String(c).padStart(2)}  ${o}${c === 0 ? "   ← 還沒用過" : ""}`);
      }
    }
  }
}

function cmdCsv() {
  const axisNames = [...new Set(Object.values(cfg.channels).flatMap((c) => Object.keys(c.axes)))];
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  console.log(["編號", "頻道", "狀態", "備註", ...axisNames, "完整提示詞"].map(esc).join(","));
  for (const r of log) {
    const ch = cfg.channels[r.channel];
    console.log([r.id, r.channel, r.status, r.note, ...axisNames.map((a) => r.picks[a] ?? ""), ch ? buildPrompt(ch, r.picks) : ""].map(esc).join(","));
  }
}

const commands = { next: cmdNext, mark: cmdMark, add: cmdAdd, list: cmdList, stats: cmdStats, csv: cmdCsv };
(commands[cmd] ?? (() => fail(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(0, 14).join("\n"))))();
