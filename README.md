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
頻道名稱、種類、曲風顯示名稱在 `channels.json` 設定;`npm run convert` 之後,播放器的「頻道 → 曲風」選單會自動出現有歌的項目。
網址:`/live/<頻道>/playlist.m3u8`、`/live/<頻道>/<曲風>/playlist.m3u8`、`/live/all/playlist.m3u8`(全部混播)。

**存取控制**:**收聽免費,不需要登入。** 登入只用來開通「把電台嵌入自己的網站」這個進階功能。
登入與付費權限**交給 auth-hub**(做法同 VEIL / UnderCurrent):Radio Hum 不碰 Google 設定,也不自己管帳號名單。

- 按「登入」→ 導去 auth-hub 用 Google 登入 → 導回來。已經在其他共用 auth-hub 的站登入過的人,會直接登入。
- 有沒有開通嵌入功能(auth-hub 的 `radio-hum / embed`),由 **auth-hub 後台**開通;付款走你現有的 ECPay 訂閱站。
- `ADMIN_EMAILS`(`wrangler.toml`)裡的帳號是管理員:可以進 `/tracker`,也永遠可以使用嵌入功能。
- 登入後的狀態記在 Radio Hum 自己簽章的 cookie(12 小時),之後不再問 auth-hub。權限被撤銷時,最晚 12 小時後(或對方下次按「登入」時)生效。
- **設定 auth-hub 那一側的步驟**(登記 app / 功能、加入 ALLOWED_ORIGINS)見 [docs/auth-hub-setup.md](docs/auth-hub-setup.md)。沒做的話登入按鈕會導向 auth-hub 但被擋下。
- **不需要手動設定任何機密:** session 簽章金鑰第一次用到時會自動產生並存進 KV(想自己指定可 `wrangler secret put SESSION_SECRET`)。

**怎麼防止別人不付費就嵌入?**
- 沒帶金鑰的串流,只開放給我們自己的播放器(同源)與非瀏覽器的用戶端(VLC、手機播放器);別的網站上的播放器(瀏覽器標示為跨站)會被拒絕,而且我們不回 CORS 標頭,瀏覽器也讀不到內容。
- 播放器頁與 `/tracker` 頁不允許被別人用 iframe 包起來;`/embed/...` 頁面要有有效金鑰才播得出來,金鑰還可限制只能在登記的網站使用。
- **嵌入金鑰的有效期限:** 金鑰建立時記下擁有者的權限到期日(auth-hub 沒給就算 30 天);擁有者每次登入,auth-hub 確認仍有權限就自動延長,**已經沒有權限就立刻失效**。限制:如果擁有者的權限在 auth-hub 後台被撤銷、但他一直沒再登入,金鑰會用到期限為止(最多 30 天)。想做到「撤銷後立刻失效」,需要在 auth-hub 加一支給服務端呼叫的內部查詢(類似現有的 `/internal/entitlements/grant`),見 [docs/auth-hub-setup.md](docs/auth-hub-setup.md) 最後一節。
- **限制:** 這擋不住懂技術的人在自己的伺服器上轉播(用 VLC 之類的免費串流再轉出去)。若之後在意,可加 Cloudflare 的 Rate Limiting / Bot 防護。

**嵌入**:已開通的使用者在播放器右上角「嵌入到我的網站」建立金鑰(可限制允許的網站),取得 iframe 嵌入碼:
`<iframe src="https://你的網域/embed/focus?key=金鑰" width="100%" height="96" style="border:0" allow="autoplay">`
可用參數:`vis=bars|ring|wave|orbs|off`、`theme=dark`。串流網址 `/live/<頻道>/playlist.m3u8?key=金鑰` 可給自訂播放器使用。

**本機測試登入**(兩種):
1. 假登入:複製 `.dev.vars.example` 成 `.dev.vars`(內含 `DEV_LOGIN=1`),用 `http://localhost:8787/auth/dev?email=任何信箱`(加 `&embed=1` 模擬已開通)。只限 localhost。
2. 完整流程:`node scripts/mock-auth-hub.mjs`(假 auth-hub)+ `npx wrangler dev --var AUTH_HUB_ORIGIN:http://127.0.0.1:9000`,瀏覽器開 `http://127.0.0.1:8787` 按「登入」。`paid@example.com` 視為已開通嵌入功能。

**正式部署前**:
1. `npx wrangler kv namespace create USERS`,把 id 填進 `wrangler.toml`
2. `wrangler.toml` 的 `ADMIN_EMAILS` 填你自己的 Google 信箱
3. 做完 [docs/auth-hub-setup.md](docs/auth-hub-setup.md) 的 auth-hub 設定(登記 app、加入 ALLOWED_ORIGINS、開通使用者)
4. **正式環境不要設 `DEV_LOGIN`**(`deploy.sh` 也會擋)

## 介面(黑白極簡,英文)

主要用戶是跨國的,所以**播放器與嵌入版的介面都是英文**;只有管理員用的 `/tracker` 維持中文。設計稿見 `docs/mockup-bw.html`。

- **深色 / 淺色都有**:右上角圓形按鈕切換,偏好記在瀏覽器裡;第一次進站跟著系統設定。只有黑白灰,沒有彩色。
- **播放卡片**:頻道膠囊(可左右滑)→ 跳動的聲音(中間是低頻、往兩側是高頻)→ 頻道名稱 + 這首歌的特色 → 這首歌的進度與剩餘時間 → 音量、上一個 / 下一個頻道、播放 / 暫停 → 曲風膠囊。直播不能跳歌,所以左右箭頭是切換**頻道**。
- **Recipe(ⓘ 按鈕)**:這首歌的「配方」(Tempo、Lead、Scene、Texture、Structure…),只有曲目有 `tags` 時才會出現;沒有就顯示曲名。標籤的資料欄位已經準備好(`playlist.json` 每首歌可有 `tags`),**把提示詞管理器的紀錄附到歌曲上這一步還沒做**。
- **嵌入版**:一條迷你播放器(`/embed/頻道?key=…`),建議 iframe 高度 76;`?theme=dark|light`(不指定就跟著訪客的系統)。
- 鍵盤:空白鍵播放 / 暫停、←/→ 換頻道、M 靜音。尊重「減少動態」設定(會關掉聲音動畫)。
- **文字集中在 `public/i18n.js`**,目前只有英文;以後要加語言,新增一個語言物件即可。網址加 `?lang=xx` 切換。頻道名稱、說明、曲風名稱在 `channels.json`。

| 檔案 | 內容 |
|---|---|
| `public/theme.css` | 黑 / 白兩套顏色變數 |
| `public/player.css` / `player.html` / `player.js` | 播放器頁 |
| `public/embed.html` | 可嵌入其他網站的迷你播放器 |
| `public/core.js` | 播放核心(包裝 hls.js) |
| `public/vis.js` | 聲音動畫(預設「置中直條」) |
| `public/i18n.js` | 介面文字 |
| `public/tracker.html` | 管理員用的提示詞與歌庫管理(中文) |

## Suno 提示詞與歌庫管理(網站上的 `/tracker`)

管理員登入後,在網站右上角點「提示詞與歌庫」(網址 `/tracker`),不用任何指令:
- **產生**:挑出和以前用過的組合差最多的提示詞 → 複製到 Suno → 聽完按「留下」或「淘汰」,並填上歌名與備註。
- **舊紀錄的歌名寫在備註?** 在「紀錄」分頁按「把備註裡的歌名搬到歌名欄」,會列出要搬的內容讓你確認(只處理目前頻道、歌名是空的、備註有內容的紀錄),搬完備註會清空。
- **一組提示詞留下兩首**:Suno 一次生成兩首。兩首都留的話,在狀態旁選「留 2 首」,或在「歌名」欄用逗號隔開兩個名字(半形、全形逗號、頓號都可以)。進度、目標與匯出的 CSV 都是以「首數」計算,不是以提示詞組數。
- **紀錄**:所有紀錄表(含「歌名」欄,可直接編輯)、補登舊提示詞:貼上完整提示詞,可指定頻道或選「自動判斷」(拿所有頻道去比對、挑命中最多的),並填上歌名。
- **覆蓋率 & 心智圖**:每個選項用了幾次,沒用過的標紅。
- **歌庫**:已經部署上線的歌(頻道、曲風、創作者、曲名、長度),可搜尋、篩選頻道。唯讀;轉檔後要 deploy 才會出現新歌。
- **設定**:改基底提示詞、各軸選項、目標首數。
- 右上角可「匯出 Excel(CSV)」與「備份(JSON)」。

資料存在雲端(Cloudflare KV,key 為 `tracker:data`),**只有 `ADMIN_EMAILS` 裡的帳號能讀寫**,換電腦也在。兩個分頁或兩台電腦同時編輯時,後存的人會被擋下並重新載入(不會默默蓋掉對方的修改)。
預設的基底與選項來自 `prompts/axes.json`(部署時打包);在 `/tracker` 的「設定」改過的內容以雲端為準。
舊的 `npm run prompt -- ...` 指令版仍可用,但它的紀錄(`prompts/log.json`)在本機,和網站上的雲端資料是分開的;兩邊可用「備份(JSON)/ 還原 / 匯入」互相搬。

## 部署(deploy.sh)

流程參考 UnderCurrent / VEIL。`./deploy.sh`(Windows 請在 Git Bash 執行):轉檔 → 上傳新歌到 R2 → (改到程式才)型別檢查與測試 → commit(訊息自動帶時間戳記)→ 推到目前所在的分支,Cloudflare 自動部署。

- `./deploy.sh dev` 推 dev 分支(預覽網址);`./deploy.sh main` 推正式環境,**會多問一次確認**。
- `./deploy.sh --direct`:不經過 git,直接 `wrangler deploy`(第一次建立 Worker、緊急修正用)。
- `--skip-songs` 略過轉檔與上傳、`--full` 一律跑測試、`--dry-run` 只預覽、`-m "訊息"` 自訂 commit 訊息。
- 只連一次 GitHub(推送時),所以 SSH 密碼只需要輸入一次。**不要把輸出導到檔案(例如 tee)**,那樣 git 會以為不在終端機裡,改跳出另一個視窗問密碼。
- 失敗時會說清楚卡在哪一步,並等你按 Enter 才關視窗。

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
