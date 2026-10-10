# Suno 生成計畫:80 首無歌詞背景音樂

## 使用前

- 開啟 **Instrumental(純音樂)** 選項;若介面有 **Exclude / Negative style**,填入:`vocals, singing, lyrics, choir, spoken word, rap`
- 提示詞**不要寫真實歌手或樂團名字**(Suno 會拒絕,也有侵權疑慮),只描述風格、樂器、速度、情緒
- 每個提示詞每次生成 2 首,**挑 1 首**留下;預期留存率約 40–60%,所以要準備生成約 150–200 首
- 必須用**付費方案**生成(商用權),並保留每首歌的生成紀錄 / 截圖,日後證明來源
- 檢查:開頭 15 秒有無雜音、結尾是否自然、中段有沒有突然出現人聲、整首情緒是否太起伏(背景音樂不要有突然的高潮)

## 80 首的分配(第一階段:4 個頻道 × 20 首 = 80 首)

80 首約 5 小時。每個頻道 20 首約 70 分鐘會每小時重複,店家客人可能聽得出來。
建議做法:**4 個頻道各 20 首,同時把 80 首合併成「綜合」頻道**(約 5 小時不重複),先測試哪個類型受歡迎,再擴充到每頻道 40 首以上。

| 頻道 id | 名稱 | 主要客群 | 曲風 | 首數 |
|---|---|---|---|---|
| `focus` | 專注 | 讀書、工作、咖啡廳、書店 | Jazz / Bossa Nova / 鋼琴 | 20 |
| `drive` | 兜風 | 開車、運動用品店、服飾店 | City Pop 風格器樂 / Funk | 20 |
| `chill` | 放鬆 | 餐廳、民宿、美容 / SPA | Lo-fi / Ambient / 原聲吉他 | 20 |
| `night` | 深夜 | 酒吧、深夜工作、夜間營業 | Smooth Jazz / 夜間氛圍 | 20 |

之後擴充備選:`morning`(晨間明亮原聲)、`classical`(輕古典鋼琴/弦樂)、`nature`(自然音 + 輕音樂,適合 SPA / 冥想)、`latin`(拉丁輕快,適合餐廳)。

---

## 1. focus 專注(20 首)

**基底提示詞**
```
instrumental bossa nova jazz, nylon guitar, soft brushed drums, upright bass, warm electric piano, relaxed, steady groove, no solos that stand out, background music for studying, clean mix
```

**變化軸(每次換一項,避免 20 首都像同一首)**
- 速度:`70 bpm` / `85 bpm` / `100 bpm`
- 主奏:`nylon guitar` / `vibraphone` / `felt piano` / `flute` / `soft saxophone`
- 氛圍:`rainy afternoon` / `sunny morning` / `quiet library` / `cozy cafe`
- 結構:`gentle intro, steady middle, soft fade out`

**範例(完整)**
```
instrumental jazz piano trio, 80 bpm, felt piano, brushed drums, upright bass, quiet library atmosphere, calm and steady, no dramatic changes, warm and clean mix
```

## 2. drive 兜風(20 首)

**基底提示詞**
```
instrumental city pop inspired, 110 bpm, funky bass, bright electric piano, clean electric guitar with chorus, tight drums, glossy 80s synth pads, smooth and upbeat, night drive feeling, no vocals
```

**變化軸**
- 速度:`100 bpm` / `115 bpm` / `125 bpm`
- 主奏:`saxophone melody` / `synth lead` / `slap bass` / `jazz guitar`
- 場景:`coastal highway at sunset` / `city lights at night` / `morning commute` / `weekend road trip`

## 3. chill 放鬆(20 首)

**基底提示詞**
```
instrumental lo-fi chill, 75 bpm, mellow electric piano, vinyl crackle, soft boom-bap drums, warm bass, gentle ambient texture, relaxing, loopable feeling, no vocals
```

**變化軸**
- 風格:`lo-fi hip hop` / `acoustic guitar folk` / `ambient pads` / `soft piano with strings`
- 氛圍:`sunday morning` / `rainy window` / `warm sunset` / `quiet garden`
- 加入元素(輕微):`light rain sounds` / `birdsong` / `soft wind chimes`

## 4. night 深夜(20 首)

**基底提示詞**
```
instrumental smooth jazz, late night lounge, 70 bpm, soft saxophone, muted trumpet, warm Rhodes piano, slow brushed drums, deep bass, dim and intimate atmosphere, relaxed, no vocals
```

**變化軸**
- 主奏:`muted trumpet` / `tenor saxophone` / `jazz guitar` / `vibraphone` / `piano trio`
- 氛圍:`empty bar after midnight` / `neon city rain` / `hotel lounge` / `quiet street at 2am`
- 速度:`55 bpm` / `65 bpm` / `75 bpm`

---

## 命名與歸檔

檔名格式(轉檔腳本會自動拆成創作者與曲名):

```
創作者 - 曲名.mp3
```

- 每個頻道給一個固定的**虛擬創作者名稱**(例如 `Studio Focus`),讓聽眾有可辨識的品牌;不要冒用真人名字
- 曲名請取自己的名字,不要用現有歌曲名稱
- 目前的資料夾結構是 `library/music/` 單一資料夾。要做多頻道前,先依頻道分資料夾存放原檔(例如 `library/focus/`),等多頻道功能完成後再轉檔

## 品質檢查表(每首都過一遍)

- [ ] 沒有人聲、哼唱、說話聲
- [ ] 前 15 秒、結尾沒有破音或突然截斷
- [ ] 音量起伏小(沒有突然很大聲的段落)
- [ ] 不是前面已留下的歌的翻版(同頻道內旋律不要太像)
- [ ] 已記錄生成日期、使用的提示詞、Suno 方案(商用權證明)
