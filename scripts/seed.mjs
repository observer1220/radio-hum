// 把 hls-output/ 裡「還沒上傳過」的曲目,用單一 wrangler 程序並行灌進 R2。(純 Node,Windows / Mac / Linux 都能跑,不需要 bash)
//   node scripts/seed.mjs            本機模擬 R2(搭配 npm run dev 測試)
//   node scripts/seed.mjs --remote   正式 R2(需已 npx wrangler login 並啟用 R2、建好 bucket)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "hls-output");
const BUCKET = "cloudflare-radio-segments";
const remote = process.argv.includes("--remote");
const mode = remote ? "remote" : "local";

if (!fs.existsSync(OUT)) {
  console.error("找不到 hls-output/,請先執行 npm run convert");
  process.exit(1);
}

const manifestFile = path.join(OUT, `.uploaded-${mode}.json`);
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
const stampOf = (id) => {
  const f = path.join(OUT, id, ".stamp");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "legacy";
};
const ids = fs.readdirSync(OUT).filter((n) => fs.statSync(path.join(OUT, n)).isDirectory());
const pending = ids.filter((id) => manifest[id] !== stampOf(id));

const items = [];
for (const id of pending) {
  for (const f of fs.readdirSync(path.join(OUT, id))) {
    if (!f.startsWith(".")) items.push({ key: `${id}/${f}`, file: path.join(OUT, id, f) });
  }
}

if (items.length === 0) {
  console.log("沒有新檔案需要上傳。");
  process.exit(0);
}
console.log(`待上傳 ${pending.length} 個曲目,共 ${items.length} 個檔案(已上傳過的略過)→ ${remote ? "正式 R2" : "本機 R2"}`);

const list = path.join(os.tmpdir(), `r2-bulk-${Date.now()}.json`);
fs.writeFileSync(list, JSON.stringify(items));

// Windows 的 npx 是 .cmd,需要 shell;路徑加引號避免空白出問題
const q = (s) => `"${s}"`;
const cmd = ["npx", "wrangler", "r2", "bulk", "put", BUCKET, "--filename", q(list), remote ? "--remote" : "--local", "--concurrency", "50", "--force"].join(" ");
const r = spawnSync(cmd, { stdio: "inherit", shell: true, cwd: ROOT });
fs.rmSync(list, { force: true });

if (r.status !== 0) {
  console.error("\n上傳失敗,沒有標記為已上傳,修好問題後重跑同一個指令即可(只會補傳沒成功的)。");
  process.exit(r.status ?? 1);
}
for (const id of ids) manifest[id] = stampOf(id);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
console.log(remote ? "完成。接著執行 npx wrangler deploy 讓新歌出現在網站上。" : "完成。可以執行 npm run dev 測試了。");
