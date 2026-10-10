export interface Env {
  RADIO_BUCKET: R2Bucket;
  USERS: KVNamespace; // 嵌入金鑰、提示詞管理器資料、(必要時)自動產生的 session 簽章金鑰
  ASSETS: Fetcher;

  // 登入與付費權限交給 auth-hub(做法同 VEIL / UnderCurrent)。Radio Hum 不碰 Google 設定,也不自己維護帳號名單。
  AUTH_HUB?: Fetcher; // service binding(wrangler.toml 的 [[services]])。同帳號的 workers.dev 之間不能直接 fetch,要走這個
  AUTH_HUB_ORIGIN?: string; // 預設 https://auth-hub.observer1220.workers.dev;本機測試時可指到 scripts/mock-auth-hub.mjs
  AUTH_APP?: string; // 在 auth-hub 登記的服務 slug,預設 radio-hum
  AUTH_FEATURE?: string; // 在 auth-hub 登記的付費功能 slug(嵌入功能),預設 embed
  SUBSCRIBE_URL?: string; // 「前往訂閱」按鈕的網址;沒設就依網域選 pay.kentshen.com 或 ecpay-donation

  SESSION_SECRET?: string; // 選填。沒設的話第一次用到時自動產生一組亂數存進 KV
  ADMIN_EMAILS?: string; // 逗號分隔;這些帳號可以進 /tracker,也永遠可以使用嵌入功能
  DEV_LOGIN?: string; // "1" 才開啟 /auth/dev 假登入(只限 localhost,正式環境不要設)
}
