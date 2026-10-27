# Assets

個人資產儀表板：打開就能看到淨資產、配置與走勢。現金、台股、加密貨幣、台灣期貨、房地產（投入現金 + 房貸）統一換算成 TWD。

- **即時報價**：台股走 FinMind `taiwan_stock_tick_snapshot`（sponsor 方案，約 10 秒更新；失敗時退回最新收盤價並標示「收盤價」），加密貨幣走 CoinGecko，外幣匯率走 open.er-api.com。頁面開著時每 30 秒更新一次。
- **每日快照**：每天 23:55（台北時間）自動記錄一次；伺服器啟動時若當天還沒有快照也會補一筆。`歷史快照` 頁可手動觸發。
- **合約（U 本位）**：每個合約帳戶記錄錢包餘額 (USDT)，底下記錄持倉（方向、數量、開倉均價、槓桿）。淨資產只計入**權益 = 錢包餘額＋未實現損益**，名目價值只用來顯示曝險與實際槓桿；加密貨幣頁另有現貨＋合約的每幣淨曝險。手動帳戶的現價以 CoinGecko USD 價格 ÷ USDT 價格估算，和交易所標記價格會有些微差距；Bybit 同步的帳戶直接用交易所的標記價、未實現損益和強平價。
- **Bybit 唯讀同步**（統一交易帳戶 UTA）：合約帳戶的來源選「Bybit」、加密貨幣帳戶在 `交易紀錄` 頁的帳戶設定把來源改成「Bybit」，各只能連一個。
  - 每分鐘：錢包餘額（統一交易帳戶＋資金帳戶的 USDT 都算合約帳戶的）、USDT 永續部位、標記價、強平價、維持保證金率。
  - 每 10 分鐘：USDT 錢包的交易紀錄（平倉損益、手續費、資金費率）和 USDT 入金／提領自動記進合約帳戶的帳本（幣別 USDT）；現貨成交自動記進加密貨幣帳戶，價格用成交價 × 計價幣的台幣價；其他幣的入金和提領放進「待確認」；最後把每個幣的餘額和帳本對一次。
  - 連結之前的紀錄不會讀：連結那一刻的餘額就是起點。不支援 Earn、跟單、子帳戶。
  - API key：在 Bybit 建 **Read-Only** 的 key，只勾合約、現貨、錢包的讀取，**綁定 VM 的 IP**，填 `BYBIT_API_KEY`、`BYBIT_API_SECRET`。Bybit 拒絕美國與中國大陸的 IP（回 403），VM 要放在其他地區。
- **待確認（對帳收件匣）**：同步或匯入找到、帳本還沒有的東西不會直接改帳本，而是列在 `交易紀錄` 頁最上面（總覽頁和每日摘要會提示筆數）：
  - 幣的入金／提領：確認時選入金（填這批的成本，預設是當時市價）、出金，或「轉帳」到自己的另一個帳戶（成本跟著轉，提領手續費留在原帳戶記成手續費）。
  - 餘額差異：交易所或對帳單的數字和帳本不同時列出差額，可以記成調整、買賣等，或略過（數字再變時會重新出現）。同步的差異要持續 15 分鐘才會出現，避免成交和餘額讀取的時間差。
  - 帳本暫時記不進去的成交（例如賣出的幣還在等入金確認）會留在這裡，每次同步自動重試。
- **券商 CSV 匯入**：股票不在永豐，所以用券商網站匯出的 CSV。`交易紀錄` 頁的「匯入對帳單」：
  - 成交明細：預覽每一筆（同一筆重複匯入不會重複記，看起來已經手動記過的會標出來），勾選後記進指定的券商帳戶；同一天先買後賣，當沖也記得進去。檔案沒有手續費／證交稅時依帳戶折扣自動算。
  - 庫存：和帳本在對帳單日期的持股比對，不同的列到「待確認」。
  - 欄位依各家券商常見的名稱辨認（成交日期、股票代號、買賣別、成交股數或張數、成交價、手續費、交易稅、庫存股數…），支援 UTF-8 和 Big5、民國年；融資融券的列不支援，會列出來略過。認不出欄位時會顯示檔案開頭，方便補上新的欄位名稱（`src/lib/broker-csv.ts` 的 `FIELDS`）。
- **台灣期貨**：每個期貨帳戶只計入**權益數**（帳戶餘額＋未平倉損益）。來源二選一：手動輸入（例如台新），或永豐 API 自動同步（權益數、未平倉損益、可用保證金、風險指標；期貨交易時段每 3 分鐘、其餘每小時，同步失敗時保留上一次的數字）。永豐走 `sinopac/server.py` 這個 sidecar：用 Shioaji 維持一個登入中的 session，只提供 `GET /margin`，只在 compose 內部網路可連；金鑰請用**沒有「交易」權限**、IP 限定 VM 的唯讀 key。
- **房貸**：依撥款日、利率、年限、寬限期自動計算剩餘本金（本息平均攤還）；有提前還款時可手動覆寫剩餘本金。
- **交易帳本**：股票、加密貨幣現貨與現金帳戶以交易紀錄為準（`交易紀錄` 頁，`/transactions`；在各頁點標的名稱可以看它的紀錄）。類型有期初、買進、賣出、股利（現金／配股）、調整，以及同步會用到的入金、出金、轉帳、手續費、資金費率、平倉損益；現金帳戶改餘額時，差額會自動記成一筆當天的調整。
  - 持股是把每個（帳戶、標的）的紀錄依交易日重播：成本是含買進手續費的移動平均（和券商 app 的算法一致），賣出依比例扣掉成本，已實現損益＝淨收入（扣手續費與證交稅）－扣掉的成本。配股和調整增加的股數不加成本；入金和轉入依填的單價加成本，沒填就是成本未知。部位從 0 開始用這些不帶成本的方式加進來的，成本會顯示未知，直到出清為止。
  - 台股手續費：0.1425% × 帳戶折扣，無條件捨去，整股最低 20 元、零股 1 元。證交稅：股票 0.3%、ETF 0.1%，債券 ETF 到 2026 年底免徵。表單會自動帶入，也可以手動改。折扣在 `交易紀錄` 頁下方的帳戶設定填折數，例如 2.8 折。加密貨幣的手續費自己填。
  - 每筆交易都記來源與外部編號，自動同步或匯入重跑也不會重複入帳；同步和匯入的紀錄不能在表單裡改。Bybit 同步的合約錢包在帳本裡；手動的合約帳戶、台灣期貨、房地產還不在。
  - **上線方式**：第一次啟動時，原本每一筆持股和現金餘額各轉成一筆「期初」交易，數字不變。接著先跑**影子模式**：
    - 各頁仍然顯示舊的持股表，新增或修改交易時兩邊一起寫。
    - 每 5 分鐘比對一次，不一致就發告警，並列在 `系統狀態` 頁。
    - 連續一致 7 天後，`系統狀態` 頁的「改用帳本計算」按鈕才能按。切過去之後舊表照樣同步，隨時可以切回。
  - **回滾**：舊版程式只讀寫舊表。換回新版時，舊版期間新增的持股與現金帳戶會自動補成期初交易（log 會記一行），但舊版期間改過的數字不會進帳本；比對會抓出來，到 `交易紀錄` 補一筆調整即可。
- **告警與系統狀態**：每 5 分鐘做一次健康檢查，有狀況就發 Telegram，並記在 `系統狀態` 頁（`/status`，總覽頁也會出現提示條）。檢查項目：
  - 永豐期貨**追繳**、**風險指標**低於門檻（預設 150% 警示、100% 緊急；期貨盤中每 3 分鐘同步完立刻檢查）
  - Bybit 部位**距強平**小於門檻（標記價再往不利方向走幾 % 會被強平；預設 15% 警示、7% 緊急）、帳戶**維持保證金率**高於門檻（預設 50% 警示、75% 緊急，到 100% 強平）。每分鐘同步完立刻檢查；全倉模式下單一部位的強平價是 Bybit 的估計。
  - 永豐或 Bybit 同步持續失敗、台股／加密貨幣／匯率報價中斷（持有的標的超過更新週期沒有新報價）
  - 每日快照沒跑或失敗、VM 上的資料庫備份與每週還原演練失敗或沒有按時回報
  - 交易帳本和舊持股表算出來的數字不一致
  - 同一個告警持續時，緊急的每 30 分鐘、警示的每 12 小時再提醒一次；解除時發「已恢復」。00:00–07:00 的警示靜音送達，緊急的照常響。
  - 每晚 23:55 快照後發一則**每日摘要**，預設只有百分比（Telegram 不是端對端加密），`TELEGRAM_DIGEST=full` 才帶金額。
  - 設定：用 [@BotFather](https://t.me/BotFather) 建 bot，把它加進要收通知的聊天（自己或家庭群組）並傳一則訊息，再從 `https://api.telegram.org/bot<token>/getUpdates` 找到 `chat.id`，填 `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`。`系統狀態` 頁右上角可以傳測試訊息。
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
`assets-restore-check.timer` 每週日 04:30 把最新一份備份從 R2 抓回來還原到暫存檔，檢查 integrity、schema 版本與最近的快照日期（不碰正式資料庫）。
兩者都會把結果 POST 到 app 的 `/api/heartbeat`（`127.0.0.1:3100`，帶 `HEARTBEAT_TOKEN`；edge Caddy 對外一律擋掉這個路徑），失敗或沒有按時回報就會發 Telegram。

| VM 上的路徑 | 內容 |
| --- | --- |
| `/opt/assets/.env` | 給 container 的設定（`FINMIND_TOKEN`、`APP_PASSWORD`…），範本 `infra/vm/env.production.example` |
| `/opt/assets/backup.env` | R2 金鑰與 `HEARTBEAT_TOKEN`，只給 `backup.sh`、`restore-check.sh`，範本 `infra/vm/backup.env.example` |
| `/opt/assets/sinopac.env` | 永豐唯讀 API key（`SJ_API_KEY`、`SJ_SEC_KEY`），只給 sinopac sidecar，範本 `infra/vm/sinopac.env.example` |
| `/opt/assets/data/assets.db` | SQLite（container 的 `/data`） |
| `/opt/assets/state/`、`releases.log` | 部署狀態與紀錄，同 HQ |
| `/etc/caddy/sites/assets.caddy` | edge Caddy 的站台設定，來源 `infra/caddy/assets.caddy` |

### 初始化（一次）

```bash
rsync -a --delete infra/ hq:/root/assets-infra/
ssh hq /root/assets-infra/vm/setup.sh          # 先跑過 homuchen-edge 與 HQ 的 setup.sh
# 填 /opt/assets/.env、/opt/assets/backup.env
ssh hq 'sudo -u deploy /opt/assets/deploy.sh sha-<7碼> && systemctl enable --now assets-deploy.timer assets-backup.timer assets-restore-check.timer'
```

GitHub：secret `DEPLOY_WEBHOOK_SECRET`（VM 的 `/etc/assets/deploy-webhook.env`）、variable `DEPLOY_URL=https://assets.homuchen.com`。
改了 `infra/` 裡的腳本、units 或 Caddy 站台時，重跑上面兩行 `rsync` + `setup.sh`。

### 日常操作

```bash
gh workflow run Deploy                       # 部署 main 最新版；-f sha=<7碼> 回到舊版
ssh hq journalctl -u assets-deploy -n 50     # 部署紀錄（也看 /opt/assets/releases.log）
ssh hq journalctl -u assets-backup -n 20     # 備份紀錄
ssh hq journalctl -u assets-restore-check -n 20   # 還原演練紀錄；要馬上跑一次：ssh hq systemctl start assets-restore-check
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
| `TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID` | 告警與每日摘要送到哪裡；沒設定時告警只記在 `系統狀態` 頁 |
| `TELEGRAM_DIGEST` | 每日摘要：`pct`（預設，只有百分比）、`full`（含金額）、`off` |
| `ALERT_TW_RISK_WARN`、`ALERT_TW_RISK_URGENT` | 期貨風險指標告警門檻（%），預設 150、100 |
| `BYBIT_API_KEY`、`BYBIT_API_SECRET` | Bybit 唯讀 API key（綁 VM 的 IP）；沒設定時合約與加密貨幣帳戶只能手動 |
| `BYBIT_BASE_URL` | 選填，預設 `https://api.bybit.com` |
| `ALERT_LIQ_WARN`、`ALERT_LIQ_URGENT` | Bybit 距強平告警門檻（%），預設 15、7 |
| `ALERT_MMR_WARN`、`ALERT_MMR_URGENT` | Bybit 維持保證金率告警門檻（%），預設 50、75 |
| `HEARTBEAT_TOKEN` | VM 上的備份與還原演練回報用，要和 `backup.env` 裡的同值（`openssl rand -hex 32`）；沒設定時不檢查備份 |

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
npm run test:coverage    # CI 跑這個；src/lib 行覆蓋率低於 80% 會失敗
```

## 架構

- Next.js 16（App Router, Server Actions）+ Tailwind v4 + Recharts
- `better-sqlite3`，schema 在 `src/lib/db.ts`：`MIGRATIONS` 依序執行，版本記在 `PRAGMA user_version`。改 schema 一律**新增**一個 migration（不要改舊的），而且只做加法（新表、有預設值的欄位），這樣部署失敗回滾到舊版時，舊程式還能在新 schema 上跑
- `src/instrumentation.ts` 啟動 `node-cron` 排程（`src/lib/scheduler.ts`）
- `src/lib/prices.ts` 報價抓取與快取，`src/lib/portfolio.ts` 彙總，`src/lib/snapshot.ts` 每日快照
- `src/lib/ledger.ts` 帳本的讀取與重播（持股、成本、已實現損益），`src/lib/transactions.ts` 寫入（檢查、同時更新舊表），`src/lib/legacy.ts` 舊持股表的同步與比對，`src/lib/holdings.ts` 依 `ledger_mode` 決定各頁讀哪一邊，`src/lib/fees.ts` 台股手續費與證交稅
- `src/lib/bybit.ts` Bybit V5 唯讀同步（直接從 Node 呼叫，簽名、分頁、餘額、交易紀錄、成交、出入金），`src/lib/inbox.ts` 待確認（差異與要確認的紀錄、確認成交易），`src/lib/broker-csv.ts` 券商 CSV 解析（純函式），`src/lib/import.ts` 匯入成交明細與庫存
- `src/lib/monitor.ts` 健康檢查，`src/lib/alerts.ts` 告警狀態（開啟、重送、解除），`src/lib/telegram.ts` 發送，`src/lib/jobs.ts` 記錄每個排程、報價來源與 VM 回報的最後結果
