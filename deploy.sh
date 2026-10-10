#!/usr/bin/env bash
# deploy.sh — 一鍵:檢查 → 轉檔 → 上傳音訊到 R2 → 部署
#
# 順序很重要:音訊一定要「先」上傳到 R2,網站程式「後」部署。
# 因為曲目清單(playlist.json)是打包在程式裡的,如果程式先上線、音訊還沒到,聽眾會遇到 404。
#
# 部署方式有兩種(腳本會自動判斷):
#   ① 已綁定 GitHub + Cloudflare(Workers Builds):腳本 commit 並 push,Cloudflare 收到 push 後自動建置、部署
#   ② 沒有 git 遠端,或加 --direct:腳本直接執行 wrangler deploy
#
# 用法:./deploy.sh [選項]
#   -m, --message "訊息"   git commit 訊息(預設:deploy: 日期時間)
#   --skip-convert         略過轉檔(沒有新歌時可省時間)
#   --skip-upload          略過上傳到 R2
#   --direct               不經 GitHub,直接 wrangler deploy
#   --no-push              只 commit,不 push
#   --dry-run              只顯示會做什麼,不真的執行(也不會因設定未完成而中止)
#   --no-pause             結束時不要等按鍵(預設:雙擊開啟的視窗,結束前會停住讓你看結果;失敗時一律停住)
#   -h, --help             顯示說明
#
# Windows:請在「Git Bash」裡執行(PowerShell 裡的 bash 可能指到沒有安裝好的 WSL)。
set -euo pipefail
set +H   # 關閉 history expansion:有些環境會把雙引號裡的 ! 誤判成「指令歷史」而語法錯誤
cd "$(dirname "${BASH_SOURCE[0]}")"

# 所有輸出同時存到 deploy.log(已被 .gitignore 排除),視窗關掉後也查得到發生了什麼事
exec > >(tee deploy.log) 2>&1

SKIP_CONVERT=0; SKIP_UPLOAD=0; DIRECT=0; NO_PUSH=0; DRY=0; NO_PAUSE=0; MSG=""
usage() { sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message) MSG="${2:?請在 $1 後面給 commit 訊息}"; shift ;;
    --skip-convert) SKIP_CONVERT=1 ;;
    --skip-upload) SKIP_UPLOAD=1 ;;
    --direct) DIRECT=1 ;;
    --no-push) NO_PUSH=1 ;;
    --dry-run) DRY=1 ;;
    --no-pause) NO_PAUSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知的選項:$1(用 --help 看說明)" >&2; exit 1 ;;
  esac
  shift
done

STEP="啟動"
say()  { STEP="$*"; printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
# 設定問題:正式執行時中止;dry-run 只提醒
problem() { if [ "$DRY" = 1 ]; then warn "(dry-run 只提醒)$*"; else die "$*"; fi; }
need() { command -v "$1" >/dev/null 2>&1 || die "找不到 $1,請先安裝"; }

# 不管成功或失敗都會執行:失敗時說清楚卡在哪一步;
# 如果是「雙擊 / 另開視窗」執行的(SHLVL<=1),或失敗了,就停住等你按鍵,不然視窗一關就看不到訊息
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    printf '\n\033[31m✗ 失敗:卡在「%s」(結束代碼 %s)。完整紀錄:%s/deploy.log\033[0m\n' "$STEP" "$code" "$PWD"
  fi
  if [ "$NO_PAUSE" != 1 ] && [ -t 0 ] && { [ "$code" -ne 0 ] || [ "${SHLVL:-1}" -le 1 ]; }; then
    read -r -n 1 -s -p $'\n按任意鍵關閉視窗…' || true
    echo
  fi
}
trap on_exit EXIT

# ---------------------------------------------------------------- 1. 環境與設定檢查
say "1/5 檢查環境與設定"
need node; need npm; need npx
[ "$SKIP_CONVERT" = 1 ] || need ffmpeg
if [ ! -d node_modules ]; then run npm install; fi

# wrangler.toml:正式部署前必須完成的設定
grep -Eq '^[[:space:]]*id[[:space:]]*=' wrangler.toml \
  || problem "wrangler.toml 還沒填 KV 的 id。請先執行 npx wrangler kv namespace create USERS,再把輸出的 id 填進 [[kv_namespaces]]"
grep -Eq '^ADMIN_EMAILS[[:space:]]*=[[:space:]]*"[^"]+"' wrangler.toml \
  || problem "wrangler.toml 的 ADMIN_EMAILS 是空的。請填你自己的 Google 信箱,否則沒有人能進後台"
if grep -Eq '^[[:space:]]*DEV_LOGIN' wrangler.toml; then
  problem "wrangler.toml 裡有 DEV_LOGIN。這是本機測試用的假登入,正式環境絕對不能開"
fi
[ -f playlist.json ] || problem "找不到 playlist.json,請先放歌並執行轉檔"

# 走 GitHub 流程時,先確認連得上遠端(讀取權限)。這是最常失敗、也最浪費時間的一步
if [ "$DIRECT" = 0 ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then
  ORIGIN="$(git remote get-url origin)"
  if ! GIT_TERMINAL_PROMPT=0 timeout 25 git ls-remote origin >/dev/null 2>&1; then
    problem "連不上 GitHub 遠端:$ORIGIN
   常見原因:① SSH 金鑰沒有加到 GitHub(或有密碼、沒載入 ssh-agent) ② repo 名稱或帳號打錯 ③ 還沒登入。
   最簡單的修法(Windows 建議):改用 HTTPS,第一次 push 會跳出瀏覽器登入,之後就記住了:
     git remote set-url origin https://github.com/你的帳號/你的repo.git
   或者先不經 GitHub,直接部署:./deploy.sh --direct"
  fi
fi
ok "設定檢查完成"

# ---------------------------------------------------------------- 2. 型別檢查與測試
say "2/5 型別檢查與測試"
run npx tsc --noEmit -p .
run npm test
ok "通過"

# ---------------------------------------------------------------- 3. 轉檔
say "3/5 轉檔(只處理新增或修改過的檔案)"
if [ "$SKIP_CONVERT" = 1 ]; then warn "已略過"; else run npm run convert; fi

# ---------------------------------------------------------------- 4. 上傳音訊到 R2
say "4/5 上傳音訊到 R2(只傳還沒傳過的)"
if [ "$SKIP_UPLOAD" = 1 ]; then
  warn "已略過"
else
  if [ "$DRY" = 0 ]; then
    npx wrangler whoami >/dev/null 2>&1 || die "尚未登入 Cloudflare。請先執行:npx wrangler login"
  fi
  run npm run seed:remote
fi

# ---------------------------------------------------------------- 5. 部署
say "5/5 部署"
HAS_REMOTE=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then HAS_REMOTE=1; fi

if [ "$DIRECT" = 1 ] || [ "$HAS_REMOTE" = 0 ]; then
  [ "$DIRECT" = 1 ] || warn "找不到 git 遠端(origin),改用 wrangler 直接部署。綁定 GitHub 後會自動走 push 流程"
  run npx wrangler deploy
  [ "$DRY" = 1 ] || ok "已直接部署到 Cloudflare"
  exit 0
fi

# --- GitHub + Cloudflare 綁定流程:commit → push,由 Cloudflare 自動建置部署 ---
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "(detached)")"  # 全新專案還沒有 commit 時 rev-parse HEAD 會失敗,所以用 symbolic-ref
case "$BRANCH" in main|master) ;; *) warn "目前在分支「$BRANCH」。Cloudflare 預設只會部署正式分支(通常是 main),請確認這是你要的" ;; esac

# 機密不能進 git
if git ls-files --error-unmatch .dev.vars >/dev/null 2>&1; then
  problem ".dev.vars 已被 git 追蹤。請先執行 git rm --cached .dev.vars,並確認 .gitignore 有列入"
fi
LEAK="$(git ls-files -co --exclude-standard | grep -v '^public/.*\.js$\|^package-lock.json$' \
  | xargs grep -IlE 'sk_(live|test)_[A-Za-z0-9]{16,}|GOCSPX-[A-Za-z0-9_-]{10,}|whsec_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null || true)"
if [ -n "$LEAK" ]; then
  printf '%s\n' "$LEAK" >&2
  problem "上面的檔案疑似含有金鑰或機密,已中止。機密請用 wrangler secret put 設定,不要寫進檔案"
fi

run git add -A
if [ "$DRY" = 1 ]; then
  echo "[dry-run] git status --short"; git status --short 2>/dev/null | head -20 || true
elif git diff --cached --quiet; then
  warn "沒有檔案變更,不需要 commit"
else
  git status --short
  git commit -m "${MSG:-deploy: $(date '+%Y-%m-%d %H:%M')}"
fi

if [ "$NO_PUSH" = 1 ]; then
  warn "--no-push:已 commit,沒有 push。要部署請執行 git push"
else
  run git push origin HEAD
  ok "已 push。Cloudflare 會自動建置並部署,請到 Dashboard → Workers & Pages → 你的專案 → 部署紀錄 查看進度"
fi
