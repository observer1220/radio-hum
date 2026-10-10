#!/usr/bin/env bash
# deploy.sh —— 版更用(流程參考 UnderCurrent / VEIL)
# 轉檔 → 上傳新歌到 R2 → (必要時)型別檢查與測試 → commit(訊息自動帶時間戳記)→ 推到目前所在的分支
# 推上去之後 Cloudflare Workers Builds 會自動部署(dev 分支 → 預覽網址,main → 正式環境)。
#
# 順序很重要:音訊一定要「先」上傳到 R2,程式「後」部署。曲目清單(playlist.json)是打包在程式裡的,
# 程式先上線、音訊還沒到的話,聽眾會遇到 404。
#
# 用法:
#   ./deploy.sh                 # 推到目前所在的分支
#   ./deploy.sh dev             # 切到 dev 分支再推(沒有這個分支會自動建立)
#   ./deploy.sh main            # 切到 main 分支再推(會多一道確認,避免手滑推正式環境)
#   ./deploy.sh main -m "訊息"  # 自訂 commit 訊息
#   ./deploy.sh --direct        # 不經過 git,直接 wrangler deploy 到正式環境(第一次建立 Worker、緊急修正用)
#   ./deploy.sh --skip-songs    # 略過轉檔與上傳(沒有新歌時可省時間)
#   ./deploy.sh --full          # 不管改了什麼,型別檢查與測試都跑一次
#   ./deploy.sh --dry-run       # 只顯示會做什麼,不真的執行
#
# Windows:請在「Git Bash」裡執行(PowerShell 裡的 bash 可能指到沒有安裝好的 WSL)。
set -euo pipefail
set +H   # 關閉 history expansion:互動模式下,雙引號裡的 ! 會被誤判成「指令歷史」而語法錯誤
cd "$(dirname "${BASH_SOURCE[0]}")"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
CURRENT_STEP="前置檢查"
DRY=0
step() { CURRENT_STEP="$1"; echo -e "\n${G}▶ $1${N}"; }
warn() { echo -e "${Y}⚠ $1${N}"; }
die()  { echo -e "${R}✘ $1${N}"; exit 1; }
run()  { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
# 設定問題:正式執行時中止;dry-run 只提醒
problem() { if [ "$DRY" = 1 ]; then warn "(dry-run 只提醒)$1"; else die "$1"; fi; }

# 失敗時說清楚停在哪一步,並等按 Enter 才結束,錯誤訊息不會跟著視窗一起消失。
# 注意:不要把輸出另外導去檔案(例如 tee)。那樣 git 會以為不在終端機裡,
# 改跳出另一個視窗問 SSH 密碼,而且會問不只一次。
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo -e "\n${R}✘ 部署在「${CURRENT_STEP}」這一步失敗(結束代碼 $code)。${N}"
    { read -r -p "按 Enter 關閉…" _ </dev/tty; } 2>/dev/null || true
  elif [ "${SHLVL:-1}" -le 1 ] && [ "$DRY" = 0 ]; then
    # 雙擊開啟的視窗,成功後也停一下讓你看到結果
    { read -r -p "完成。按 Enter 關閉…" _ </dev/tty; } 2>/dev/null || true
  fi
}
trap on_exit EXIT

TARGET_BRANCH=""; MSG=""; DIRECT=0; FULL=0; SKIP_SONGS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --direct) DIRECT=1 ;;
    --full) FULL=1 ;;
    --skip-songs) SKIP_SONGS=1 ;;
    --dry-run) DRY=1 ;;
    -m) shift; MSG="${1:-}" ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; trap - EXIT; exit 0 ;;
    -*) die "不認得的參數:$1(用 --help 看說明)" ;;
    *) TARGET_BRANCH="$1" ;;
  esac
  shift
done
MSG="${MSG:-Update: $(date '+%Y-%m-%d %H:%M:%S')}"

# ── 0. 前置檢查 ──
command -v node >/dev/null 2>&1 || die "找不到 node,請先安裝"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "這個資料夾還不是 git repo"
[ -d node_modules ] || { step "安裝套件"; run npm install --no-audit --no-fund; }

# wrangler.toml:正式部署前必須完成的設定
grep -Eq '^[[:space:]]*id[[:space:]]*=' wrangler.toml \
  || problem "wrangler.toml 還沒填 KV 的 id。請先執行 npx wrangler kv namespace create USERS,再把輸出的 id 填進 [[kv_namespaces]]"
grep -Eq '^ADMIN_EMAILS[[:space:]]*=[[:space:]]*"[^"]+"' wrangler.toml \
  || problem "wrangler.toml 的 ADMIN_EMAILS 是空的。請填你自己的 Google 信箱,否則沒有人能進 /tracker"
if grep -Eq '^[[:space:]]*DEV_LOGIN' wrangler.toml; then
  problem "wrangler.toml 裡有 DEV_LOGIN。這是本機測試用的假登入,正式環境絕對不能開"
fi
if git ls-files --error-unmatch .dev.vars >/dev/null 2>&1; then
  problem ".dev.vars 被加進 git 了,請先 git rm --cached .dev.vars"
fi

# ── 1. 切換分支 ──
if [ -n "$TARGET_BRANCH" ] && [ "$DIRECT" = 0 ]; then
  if git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
    echo "切換到分支:$TARGET_BRANCH"; run git checkout "$TARGET_BRANCH"
  else
    echo "建立並切換到新分支:$TARGET_BRANCH(從目前的 $(git branch --show-current) 分出去)"; run git checkout -b "$TARGET_BRANCH"
  fi
fi
CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || true)"   # 全新專案還沒有 commit 時也能用
[ -n "$CURRENT_BRANCH" ] || die "目前不在任何分支上(detached HEAD),請先切到 main 或 dev"

# 推正式環境前多一道確認,避免手滑
if [ "$CURRENT_BRANCH" = "main" ] || [ "$DIRECT" = 1 ]; then
  if [ "$DRY" = 1 ]; then
    echo "[dry-run] (正式環境會在這裡問一次確認)"
  else
    read -r -p "⚠️  即將部署到正式環境,確定嗎?(y/N) " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then echo "已取消。"; trap - EXIT; exit 0; fi
  fi
fi

# ── 2. 判斷這次改了什麼:已 commit 但還沒推的,加上還沒 commit 的 ──
# 用本機記得的「上次推到哪裡」(origin/分支)比對,不另外連 GitHub,SSH 密碼只需要在推送時輸入一次
BASE="origin/$CURRENT_BRANCH"
git rev-parse --verify -q "$BASE" >/dev/null || BASE="origin/main"
CHANGED=$( { git diff --name-only "$BASE"...HEAD 2>/dev/null || true; git diff --name-only HEAD 2>/dev/null || true; git ls-files --others --exclude-standard; } | sort -u )
changed() { [ "$FULL" = 1 ] || echo "$CHANGED" | grep -qE "$1"; }

# ── 3. 新歌:轉檔 → 上傳 R2(兩個都只處理新增或修改過的,沒有新歌時幾秒就結束)──
if [ "$SKIP_SONGS" = 1 ]; then
  echo "(已略過轉檔與上傳)"
else
  command -v ffmpeg >/dev/null 2>&1 || problem "找不到 ffmpeg,無法轉檔。沒有新歌的話可以加 --skip-songs"
  step "轉檔(只處理新增或修改過的檔案)"
  run npm run --silent convert
  step "上傳新歌到 R2(只傳還沒傳過的)"
  run npm run --silent seed:remote
fi

# ── 4. 型別檢查與測試:改到程式或測試才跑(失敗就不部署)──
if changed '^(src/|test/|tsconfig\.json|package\.json|channels\.json|schedule\.json|prompts/axes\.json)'; then
  step "型別檢查與測試"
  run npx tsc --noEmit -p .
  run npm test --silent
else
  echo "(這次沒有改到程式,略過型別檢查與測試;要強制執行請加 --full)"
fi

# ── 5a. 直接部署(不經過 git)──
if [ "$DIRECT" = 1 ]; then
  step "直接部署到 Cloudflare"
  run npx wrangler deploy
  echo -e "\n${G}✔ 完成${N}"
  warn "這次沒有 commit。之後記得把變更推上 git,免得下次自動部署把它蓋掉"
  exit 0
fi

# ── 5b. 機密不能進 git ──
LEAK="$(git ls-files -co --exclude-standard | grep -v '^package-lock.json$' \
  | xargs grep -IlE 'sk_(live|test)_[A-Za-z0-9]{16,}|GOCSPX-[A-Za-z0-9_-]{10,}|whsec_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY' 2>/dev/null || true)"
if [ -n "$LEAK" ]; then
  printf '%s\n' "$LEAK" >&2
  problem "上面的檔案疑似含有金鑰或機密,已中止。機密請用 wrangler secret put 設定,不要寫進檔案"
fi

# ── 5c. commit & push,Cloudflare Workers Builds 會自動部署 ──
step "Commit & push 到 $CURRENT_BRANCH"
run git add -A
if [ "$DRY" = 1 ]; then
  echo "[dry-run] git commit -m \"$MSG\""; git status --short | head -15 || true
elif git diff --cached --quiet; then
  echo "沒有變更可以 commit,直接嘗試推送現有的 commit…"
else
  git commit -m "$MSG"
fi
run git push -u origin "$CURRENT_BRANCH"

echo ""
echo -e "${G}✔ 已推送到 $CURRENT_BRANCH 分支${N}"
if [ "$CURRENT_BRANCH" = "main" ]; then
  echo "→ Cloudflare 會自動部署到正式環境"
else
  echo "→ Cloudflare 會自動部署到預覽網址(前提是 Dashboard 的 Settings → Build → Branch control 已打開「non-production branch builds」)"
fi
echo "  進度:Dashboard → Workers & Pages → 你的專案 → Deployments"
