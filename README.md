# Assets

個人資產儀表板：打開就能看到淨資產、配置與走勢。現金、台股、加密貨幣、台灣期貨、房地產（投入現金 + 房貸）統一換算成 TWD。

- **即時報價**：台股走 FinMind `taiwan_stock_tick_snapshot`（sponsor 方案，約 10 秒更新；失敗時退回最新收盤價並標示「收盤價」），加密貨幣走 CoinGecko，外幣匯率走 open.er-api.com。頁面開著時每 30 秒更新一次。
- **每日快照**：每天 23:55（台北時間）自動記錄一次；伺服器啟動時若當天還沒有快照也會補一筆。`歷史快照` 頁可手動觸發。
- **合約（U 本位）**：每個合約帳戶記錄錢包餘額 (USDT)，底下記錄持倉（方向、數量、開倉均價、槓桿）。淨資產只計入**權益 = 錢包餘額＋未實現損益**，名目價值只用來顯示曝險與實際槓桿；加密貨幣頁另有現貨＋合約的每幣淨曝險。現價以 CoinGecko USD 價格 ÷ USDT 價格估算，和交易所標記價格會有些微差距。
- **台灣期貨**：每個期貨帳戶只計入**權益數**（帳戶餘額＋未平倉損益）。來源二選一：手動輸入（例如台新），或永豐 API 自動同步（權益數、未平倉損益、可用保證金、風險指標；期貨交易時段每 5 分鐘、其餘每小時，同步失敗時保留上一次的數字）。永豐走 `sinopac/server.py` 這個 sidecar：用 Shioaji 維持一個登入中的 session，只提供 `GET /margin`，只在 compose 內部網路可連；金鑰請用**沒有「交易」權限**、IP 限定 VM 的唯讀 key。
- **房貸**：依撥款日、利率、年限、寬限期自動計算剩餘本金（本息平均攤還）；有提前還款時可手動覆寫剩餘本金。
- **安裝到手機（PWA）**：iPhone 用 Safari 開啟 → 分享 →「加入主畫面」；Android 用 Chrome 開啟 → 選單 →「安裝應用程式」。以全螢幕開啟，底部導覽會避開 home indicator。Service worker（`public/sw.js`）只在斷線時顯示離線頁，**不快取任何資料頁**，資產數字一律即時抓。iOS 主畫面 app 的 cookie 與 Safari 分開，第一次開啟要再登入一次。
- **漲跌顏色**：台灣慣例紅漲綠跌，並附 ▲▼ 符號。要改成國際慣例，對調 `src/app/globals.css` 的 `--up` / `--down`。

## 正式環境

跑在 homuchen.com 共用的 VM（Linode `hq-prod`，與 HQ 同台）。對外入口是 VM 層級的 edge Caddy
（[homuchen-edge](https://github.com/HoMuChen/homuchen-edge)），本服務只聽 `127.0.0.1:3100`。部署流程照搬 HQ：

```
push main ──► CI（lint、tsc）──► Build：ghcr.io/homuchen/assets:sha-xxxxxxx、:main（不部署）

gh workflow run Deploy [-f sha=xxxxxxx]
  1. :prod 指到該版
  2. POST https://assets.homuchen.com/_deploy（HMAC）→ VM 上的 receiver（127.0.0.1:9001）
  3. VM：/opt/assets/deploy.sh → pull :prod → 備份 SQLite 到 state/pre-deploy.db → 換版
     → /api/health 的 version 要等於 GIT_SHA，否則切回上一版
  4. Actions 輪詢 /api/health 直到版本更新 → 綠燈 / 紅燈
```

`assets-deploy.timer` 每 10 分鐘補檢查一次 `:prod`；`assets-backup.timer` 每天 03:30（台北）把 SQLite
備份到 R2 的 `backup/assets/`（各服務共用的 `backup` bucket，一個服務一個資料夾，HQ 在 `headquarter/`），保留最近 14 份＋近 12 個月每月一份。

| VM 上的路徑 | 內容 |
| --- | --- |
| `/opt/assets/.env` | 給 container 的設定（`FINMIND_TOKEN`、`APP_PASSWORD`…），範本 `infra/vm/env.production.example` |
| `/opt/assets/backup.env` | R2 金鑰，只給 `backup.sh`，範本 `infra/vm/backup.env.example` |
| `/opt/assets/sinopac.env` | 永豐唯讀 API key（`SJ_API_KEY`、`SJ_SEC_KEY`），只給 sinopac sidecar，範本 `infra/vm/sinopac.env.example` |
| `/opt/assets/data/assets.db` | SQLite（container 的 `/data`） |
| `/opt/assets/state/`、`releases.log` | 部署狀態與紀錄，同 HQ |
| `/etc/caddy/sites/assets.caddy` | edge Caddy 的站台設定，來源 `infra/caddy/assets.caddy` |

### 初始化（一次）

```bash
rsync -a --delete infra/ hq:/root/assets-infra/
ssh hq /root/assets-infra/vm/setup.sh          # 先跑過 homuchen-edge 與 HQ 的 setup.sh
# 填 /opt/assets/.env、/opt/assets/backup.env
ssh hq 'sudo -u deploy /opt/assets/deploy.sh sha-<7碼> && systemctl enable --now assets-deploy.timer assets-backup.timer'
```

GitHub：secret `DEPLOY_WEBHOOK_SECRET`（VM 的 `/etc/assets/deploy-webhook.env`）、variable `DEPLOY_URL=https://assets.homuchen.com`。
改了 `infra/` 裡的腳本、units 或 Caddy 站台時，重跑上面兩行 `rsync` + `setup.sh`。

### 日常操作

```bash
gh workflow run Deploy                       # 部署 main 最新版；-f sha=<7碼> 回到舊版
ssh hq journalctl -u assets-deploy -n 50     # 部署紀錄（也看 /opt/assets/releases.log）
ssh hq journalctl -u assets-backup -n 20     # 備份紀錄
ssh hq 'cd /opt/assets && ASSETS_IMAGE=$(cat state/current) docker compose -p assets -f app/compose.prod.yml logs -f --tail 100'
```

還原：停掉服務、用備份檔取代 `/opt/assets/data/assets.db`（並刪掉 `assets.db-wal`、`assets.db-shm`），再啟動：

```bash
# 從 R2 下載某一份（或用部署前的快照 /opt/assets/state/pre-deploy.db）後 gunzip
C="docker compose -p assets -f /opt/assets/app/compose.prod.yml"
export ASSETS_IMAGE=$(cat /opt/assets/state/current)
$C stop && cp assets.db /opt/assets/data/assets.db && rm -f /opt/assets/data/assets.db-{wal,shm} && $C start
```

### 本機用 Docker 試跑

```bash
cp .env.example .env        # 填入 FINMIND_TOKEN 與 APP_PASSWORD
mkdir -p data && sudo chown 1000:1000 data   # 容器以 node (uid 1000) 執行
docker compose up -d --build                 # http://localhost:3000；純 HTTP 時 .env 設 COOKIE_SECURE=false
```

### 登入安全

- 每次登入產生一組隨機 session token（cookie 為 `httpOnly`、`sameSite=lax`），資料庫只存 SHA-256 雜湊，伺服器端 30 天到期。
- 登出只會登出目前裝置；側邊欄的「登出所有裝置」會撤銷全部 session。修改 `APP_PASSWORD` 後重啟，所有既有 session 也會失效。
- 防暴力破解：同一 IP 15 分鐘內錯 5 次鎖 15 分鐘；全站 15 分鐘內累計錯 20 次則暫停所有登入 15 分鐘（已登入的裝置不受影響）。鎖定期間正確密碼也會被拒。
- 客戶端 IP 依序取自 `CF-Connecting-IP`、`X-Real-IP`、`X-Forwarded-For`，reverse proxy 必須覆寫這些 header（正式環境的 `infra/caddy/assets.caddy` 會移除 `CF-Connecting-IP` 並以真實來源覆寫 `X-Real-IP`）；直接對外暴露時 header 可被偽造，此時主要靠全站上限防護。

### 環境變數

| 變數 | 說明 |
| --- | --- |
| `FINMIND_TOKEN` | FinMind API token（sponsor 才有即時報價） |
| `APP_PASSWORD` | 登入密碼；留空則不需登入（只建議在內網使用） |
| `COINGECKO_API_KEY` | 選填，CoinGecko demo key |
| `COOKIE_SECURE` | 預設 `true`；純 HTTP 時設 `false` |
| `DATA_DIR` | SQLite 存放位置，容器內預設 `/data` |
| `DISABLE_SCHEDULER` | 設 `true` 可停用排程（例如同時跑多個實例時） |

## 本機開發

```bash
npm install
cp .env.example .env.local
npm run dev
```

要在本機測永豐同步：另開一個終端跑 sidecar，再讓 dev server 指過去。

```bash
SJ_API_KEY=... SJ_SEC_KEY=... SINOPAC_PORT=8765 uv run --with shioaji==1.7.2 python sinopac/server.py
SINOPAC_URL=http://127.0.0.1:8765 npm run dev
```

測試（vitest，每個測試檔用自己的暫存 SQLite，外部 API 一律 mock，不會打網路）：

```bash
npm test                 # 全部跑一次
npm run test:watch       # 開發時
npm run test:coverage    # CI 跑這個
```

## 架構

- Next.js 16（App Router, Server Actions）+ Tailwind v4 + Recharts
- `better-sqlite3`，schema 在 `src/lib/db.ts`：`MIGRATIONS` 依序執行，版本記在 `PRAGMA user_version`。改 schema 一律**新增**一個 migration（不要改舊的），而且只做加法（新表、有預設值的欄位），這樣部署失敗回滾到舊版時，舊程式還能在新 schema 上跑
- `src/instrumentation.ts` 啟動 `node-cron` 排程（`src/lib/scheduler.ts`）
- `src/lib/prices.ts` 報價抓取與快取，`src/lib/portfolio.ts` 彙總，`src/lib/snapshot.ts` 每日快照
