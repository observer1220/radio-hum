# Cloudflare 線上電台 — MVP 測試版

用「目前 UTC 時間 mod 播放清單總長度」算出全域播放進度,
不需要 Durable Object,Worker 本身就是無狀態的 — 所有聽眾打開同一個 `/live/playlist.m3u8`
都會聽到一樣的進度,體驗跟真的電台一樣。

## 目錄結構

- `src/index.ts` — Worker:即時 HLS playlist、提供音訊片段、播放器頁面
- `src/schedule.ts` — 節目表引擎(把一天的節目表 + 曲庫展開成時間軸),`test/` 有單元測試(`npm test`)
- `schedule.json` — **一天的節目表**(每天重複)
- `playlist.json` — 節目庫(曲目與片段資訊),由 `npm run convert` 自動產生,不用手改
- `library/music/`、`library/shows/` — 你放原始音檔的地方;`library/meta.json` 放創作者頁面、Podcast 連結等補充資訊
- `hls-output/` — 轉好的 HLS 片段(要灌進 R2 的內容)
- `scripts/` — `convert.mjs`(ffmpeg 轉檔)、`import-podcast.mjs`(RSS 匯入)、`seed.mjs`(增量上傳到 R2)

## 多頻道、登入與付費、嵌入

**頻道與曲風**:原檔放 `library/<頻道>/<曲風>/檔名.mp3`(曲風資料夾可省略),例如 `library/focus/bossa-nova/Studio Focus - Rainy Desk.mp3`。
頻道名稱、種類、曲風顯示名稱在 `channels.json` 設定;`npm run convert` 之後,播放器的「種類 → 頻道 → 曲風」選單會自動出現有歌的項目。
網址:`/live/<頻道>/playlist.m3u8`、`/live/<頻道>/<曲風>/playlist.m3u8`、`/live/all/playlist.m3u8`(全部混播)。

**存取控制**:聽眾必須用 Google 登入,且符合其一才能收聽:① 後台手動啟用 ② Stripe 訂閱有效 ③ 帳號在 `ADMIN_EMAILS`。
後台在 `/admin`(只有 `ADMIN_EMAILS` 的帳號進得去)。

**嵌入**:已啟用的使用者在播放器右上角「嵌入 / 串流」建立金鑰(可限制允許的網站),取得 iframe 嵌入碼:
`<iframe src="https://你的網域/embed/focus?key=金鑰&vis=bars" width="100%" height="220" style="border:0" allow="autoplay">`
可用參數:`vis=bars|ring|wave|orbs|off`、`theme=light`、`accent=色相0~360`。串流網址 `/live/<頻道>/playlist.m3u8?key=金鑰` 可給自訂播放器使用。

**本機測試**:複製 `.dev.vars.example` 成 `.dev.vars`,開啟 `DEV_LOGIN=1` 後用 `http://localhost:8787/auth/dev?email=任何信箱` 假登入(只限 localhost)。

**正式部署前**:
1. `npx wrangler kv namespace create USERS`,把 id 填進 `wrangler.toml`
2. `wrangler.toml` 的 `ADMIN_EMAILS` 填你自己的 Google 信箱
3. `wrangler secret put SESSION_SECRET`(隨機長字串)、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`
4. Google Cloud Console 建 OAuth 用戶端 ID(網頁應用程式),已授權重新導向 URI 填 `https://你的網域/auth/google/callback`
5. 收費:Stripe 建訂閱商品,`wrangler secret put STRIPE_SECRET_KEY`、`STRIPE_PRICE_ID`;Stripe 後台新增 Webhook 指向 `https://你的網域/billing/webhook`,事件選 `checkout.session.completed`、`customer.subscription.updated`、`customer.subscription.deleted`,把簽章密鑰設為 `STRIPE_WEBHOOK_SECRET`
6. **正式環境不要設 `DEV_LOGIN`**

## 介面

最簡單的白底版面,檔案很少:

| 檔案 | 內容 |
|---|---|
| `public/theme.css` | 幾個顏色變數(白底黑字;嵌入網址加 `?theme=dark` 為深色) |
| `public/player.css` | 全站樣式(播放器、後台、對話框) |
| `public/player.html` / `player.js` | 播放器頁:頻道清單、曲風、播放 / 音量、登入遮罩、嵌入金鑰 |
| `public/embed.html` | 可嵌入其他網站的迷你播放器 |
| `public/admin.html` | 後台(開通 / 關閉使用者) |
| `public/core.js` | 播放核心(包裝 hls.js) |
| `public/vis.js` | 小小的音量條動畫(上方「動畫」選單可關閉或換樣式) |

空白鍵 = 播放 / 暫停。嵌入網址參數:`vis=bars|ring|wave|orbs|off`、`theme=dark`。建議 iframe 高度 96。
頻道名稱與說明在 `channels.json`(`freq`、`en`、`tagline` 欄位目前沒有用到,可忽略)。

## Suno 提示詞管理

**最簡單:雙擊 `prompts/tracker.html`**(用 Chrome / Edge 開,不需要任何指令)。
按「產生」挑出和以前差最多的提示詞 → 複製到 Suno → 聽完在卡片上按「留下」或「淘汰」。另有:紀錄表、補登舊提示詞、各選項使用次數(覆蓋率)、心智圖、設定(改基底與選項)。
資料自動存在瀏覽器裡;右上角可「匯出 Excel(CSV)」和「備份(JSON)」,換電腦前請先備份。
(進階:`npm run prompt -- ...` 指令版仍然可用,資料格式相同,JSON 可互相匯入。)

## 部署(deploy.sh)

`./deploy.sh`(Windows 請在 Git Bash 執行):檢查 → 轉檔 → 上傳音訊到 R2 → 部署。已綁定 GitHub + Cloudflare 時會 commit 並 push,由 Cloudflare 自動部署;沒有 git 遠端或加 `--direct` 則直接 `wrangler deploy`。`./deploy.sh --help` 看全部選項,`--dry-run` 只預覽不執行。

## 日常流程

```bash
# 1. 放檔案:音樂 → library/music/,訪談/脫口秀 → library/shows/
#    檔名用「創作者 - 曲名.mp3」即可自動拆出創作者與曲名
npm run convert        # 只轉新增/修改過的檔案,順便做響度正規化(-16 LUFS)並更新 playlist.json
npm run seed           # 只上傳新增的曲目到本機 R2(npm run seed:remote 上傳到正式 R2)
npm run dev
```

### 排節目表(schedule.json)

```json
{ "utcOffsetMinutes": 480,
  "slots": [
    { "start": "00:00", "type": "music" },
    { "start": "08:00", "type": "show", "tracks": ["show-1a2b3c4d"] },
    { "start": "08:30", "type": "music" },
    { "start": "20:00", "type": "show", "tracks": ["show-1a2b3c4d"] }
  ] }
```

- 節目 id 在 `playlist.json` 裡(`show-` 開頭)。同一個節目列在不同時段就是「重播」。
- `music` 時段播整個音樂庫,每天用不同的洗牌順序,整副牌播完才重洗,不會連續播同一首。
- 節目沒占滿的時間會用音樂補到下一個時段。
- 為了不在歌曲中間硬切,節目可能比表定時間晚幾分鐘開始(不會累積)。

### 匯入現成 Podcast

```bash
npm run import-podcast -- https://example.com/feed.xml --limit 3
npm run convert
```

會下載最新 3 集到 `library/shows/`,並自動記下節目名稱與網站,播放器會顯示「🎙 節目」標籤和 Podcast 連結。
**只匯入你有轉播授權的節目**:Podcast 音檔版權屬於製作人,公開轉播要先徵得同意。

## 本機測試步驟

```bash
npm install
npm run dev            # 第一個終端機
npm run seed           # 第二個終端機
```

然後開瀏覽器到 `http://localhost:8787/player`,按播放。

## 之後要正式部署時

```bash
wrangler r2 bucket create cloudflare-radio-segments
# 把 hls-output/ 的內容也上傳到正式的 R2(拿掉 --local)
wrangler deploy
```

## 目前這版的限制(之後要做的事)

- **跨日(當地 00:00)時 media sequence 會跳號**,播放器可能短暫重新緩衝一下。
- 修改 `schedule.json` 或 `playlist.json` 後需重新部署,正在聽的人在下一次重新整理 playlist 時會直接跳到新內容。
- 重新轉檔同名但內容不同的檔案會產生新的片段,R2 上舊的多餘片段不會自動刪除。
- 目前片段走的是最陽春的 AAC + ADTS(沒有用 fMP4/CMAF),相容性沒問題,但之後如果要上 LL-HLS(低延遲)會需要換成 fMP4。
