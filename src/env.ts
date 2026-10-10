export interface Env {
  RADIO_BUCKET: R2Bucket;
  USERS: KVNamespace;
  ASSETS: Fetcher;
  SESSION_SECRET: string; // 簽 cookie / 串流 token 用的隨機長字串(wrangler secret put SESSION_SECRET)
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
  ADMIN_EMAILS?: string; // 逗號分隔;這些帳號永遠有權限,且可進 /admin
  DEV_LOGIN?: string; // "1" 才開啟 /auth/dev 假登入(只限 localhost,正式環境不要設)
}
