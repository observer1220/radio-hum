// 清理「殘留」的曲目:轉檔結果(hls-output)或 R2 上有,但曲庫(playlist.json)已經沒有的歌。
// 常見原因:歌曲改名、刪掉原始檔、手動刪過 R2。
//
//   node scripts/prune.mjs                    只預覽,什麼都不會刪(預設)
//   node scripts/prune.mjs --apply            刪除本機的殘留資料夾,並整理「已上傳」紀錄
//   node scripts/prune.mjs --apply --remote   連同「正式 R2」上的檔案一起刪(需已 npx wrangler login)
//
// 安全規則:曲庫(playlist.json)裡有的歌,一律不會碰。刪除 R2 失敗的曲目,本機資料夾與紀錄會保留,修好後重跑即可。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "hls-output");
const BUCKET = "cloudflare-radio-segments";
const apply = process.argv.includes("--apply");
const remote = process.argv.includes("--remote");

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "playlist.json"), "utf8"));
const inCatalog = new Set(catalog.tracks.map((t) => t.id));

const manifestPath = (mode) => path.join(OUT, `.uploaded-${mode}.json`);
const readManifest = (mode) => (fs.existsSync(manifestPath(mode)) ? JSON.parse(fs.readFileSync(manifestPath(mode), "utf8")) : {});
const manifests = { remote: readManifest("remote"), local: readManifest("local") };

const dirs = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((n) => fs.statSync(path.join(OUT, n)).isDirectory()) : [];
const orphanIds = [...new Set([...dirs, ...Object.keys(manifests.remote), ...Object.keys(manifests.local)])].filter((id) => !inCatalog.has(id)).sort();

if (!orphanIds.length) {
  console.log("沒有殘留的曲目,不需要清理。");
  process.exit(0);
}

const filesOf = (id) => (fs.existsSync(path.join(OUT, id)) ? fs.readdirSync(path.join(OUT, id)).filter((f) => !f.startsWith(".")) : []);

console.log(apply ? "== 清理殘留曲目 ==" : "== 預覽(不會刪除任何東西;確認後加 --apply)==");
for (const id of orphanIds) {
  const n = filesOf(id).length;
  const where = [dirs.includes(id) ? `本機資料夾 ${n} 個檔案` : null, manifests.remote[id] ? "正式 R2" : null, manifests.local[id] ? "本機模擬 R2" : null].filter(Boolean);
  console.log(`  ${id}:${where.join("、") || "(只剩紀錄)"}`);
}

if (!apply) {
  console.log("\n要刪除請執行:node scripts/prune.mjs --apply" + (Object.keys(manifests.remote).some((id) => orphanIds.includes(id) && filesOf(id).length) ? "  (連正式 R2 一起刪,再加 --remote)" : ""));
  process.exit(0);
}

// ---- 刪除 R2 上的單一檔案(wrangler 沒有批次刪除,一個一個刪,同時最多 6 個)----
function deleteObject(key, mode) {
  return new Promise((resolve) => {
    const p = spawn(`npx wrangler r2 object delete "${BUCKET}/${key}" --${mode}`, { shell: true, cwd: ROOT, stdio: "ignore" });
    p.on("close", (code) => resolve(code === 0));
  });
}
async function deleteAll(keys, mode = "remote") {
  let ok = 0, i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < keys.length) {
      if (await deleteObject(keys[i++], mode)) ok++;
    }
  }));
  return ok === keys.length;
}

let failed = 0;
for (const id of orphanIds) {
  const keys = filesOf(id).map((f) => `${id}/${f}`);
  let remoteOk = true;

  if (manifests.remote[id]) {
    if (!remote) {
      console.log(`  ${id}:正式 R2 上還有這首的檔案,沒有加 --remote,所以保留本機資料夾與紀錄(之後要刪再加 --remote)`);
      remoteOk = false;
    } else if (!keys.length) {
      console.log(`  ${id}:找不到本機資料夾,無法得知 R2 上的檔名。請到 Cloudflare Dashboard → R2 手動刪除 ${id}/ 這個資料夾`);
    } else {
      console.log(`  ${id}:刪除正式 R2 上的 ${keys.length} 個檔案…`);
      remoteOk = await deleteAll(keys);
      console.log(remoteOk ? "    完成" : "    有檔案刪除失敗,保留本機資料夾與紀錄,稍後重跑即可");
    }
  }

  if (remoteOk) {
    // 本機模擬 R2(wrangler dev 用的)也一起清,免得測試時還聽得到已經刪掉的歌
    if (manifests.local[id] && keys.length) {
      console.log(`  ${id}:刪除本機模擬 R2 上的檔案…`);
      await deleteAll(keys, "local");
    }
    delete manifests.remote[id];
    delete manifests.local[id];
    fs.rmSync(path.join(OUT, id), { recursive: true, force: true });
    console.log(`  ${id}:已清掉本機資料夾與上傳紀錄`);
  } else {
    failed++;
  }
}
fs.writeFileSync(manifestPath("remote"), JSON.stringify(manifests.remote, null, 1));
fs.writeFileSync(manifestPath("local"), JSON.stringify(manifests.local, null, 1));
console.log(failed ? `\n有 ${failed} 首沒有清乾淨(見上面說明)。` : "\n完成。");
process.exit(failed ? 1 : 0);
