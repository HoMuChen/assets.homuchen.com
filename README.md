# Assets

個人資產儀表板：打開就能看到淨資產、配置與走勢。現金、台股、加密貨幣、房地產（投入現金 + 房貸）統一換算成 TWD。

- **即時報價**：台股走 FinMind `taiwan_stock_tick_snapshot`（sponsor 方案，約 10 秒更新；失敗時退回最新收盤價並標示「收盤價」），加密貨幣走 CoinGecko，外幣匯率走 open.er-api.com。頁面開著時每 30 秒更新一次。
- **每日快照**：每天 23:55（台北時間）自動記錄一次；伺服器啟動時若當天還沒有快照也會補一筆。`歷史快照` 頁可手動觸發。
- **合約（U 本位）**：每個合約帳戶記錄錢包餘額 (USDT)，底下記錄持倉（方向、數量、開倉均價、槓桿）。淨資產只計入**權益 = 錢包餘額＋未實現損益**，名目價值只用來顯示曝險與實際槓桿；加密貨幣頁另有現貨＋合約的每幣淨曝險。現價以 CoinGecko USD 價格 ÷ USDT 價格估算，和交易所標記價格會有些微差距。
- **房貸**：依撥款日、利率、年限、寬限期自動計算剩餘本金（本息平均攤還）；有提前還款時可手動覆寫剩餘本金。
- **漲跌顏色**：台灣慣例紅漲綠跌，並附 ▲▼ 符號。要改成國際慣例，對調 `src/app/globals.css` 的 `--up` / `--down`。

## 部署（Docker）

```bash
cp .env.example .env        # 填入 FINMIND_TOKEN 與 APP_PASSWORD
mkdir -p data && sudo chown 1000:1000 data   # 容器以 node (uid 1000) 執行
docker compose up -d --build
```

資料都在 `./data/assets.db`（SQLite），備份這個資料夾即可。

建議放在 reverse proxy（Caddy / Nginx / Cloudflare Tunnel）後面提供 HTTPS 給 `assets.homuchen.com`。若暫時只用 HTTP 存取，請在 `.env` 設 `COOKIE_SECURE=false`，否則登入 cookie 不會被瀏覽器保存。

### 登入安全

- 每次登入產生一組隨機 session token（cookie 為 `httpOnly`、`sameSite=lax`），資料庫只存 SHA-256 雜湊，伺服器端 30 天到期。
- 登出只會登出目前裝置；側邊欄的「登出所有裝置」會撤銷全部 session。修改 `APP_PASSWORD` 後重啟，所有既有 session 也會失效。
- 防暴力破解：同一 IP 15 分鐘內錯 5 次鎖 15 分鐘；全站 15 分鐘內累計錯 20 次則暫停所有登入 15 分鐘（已登入的裝置不受影響）。鎖定期間正確密碼也會被拒。
- 客戶端 IP 依序取自 `CF-Connecting-IP`、`X-Real-IP`、`X-Forwarded-For`，請確保 reverse proxy 會覆寫這些 header；直接對外暴露時 header 可被偽造，此時主要靠全站上限防護。

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

## 架構

- Next.js 16（App Router, Server Actions）+ Tailwind v4 + Recharts
- `better-sqlite3`，schema 在 `src/lib/db.ts` 啟動時自動建立
- `src/instrumentation.ts` 啟動 `node-cron` 排程（`src/lib/scheduler.ts`）
- `src/lib/prices.ts` 報價抓取與快取，`src/lib/portfolio.ts` 彙總，`src/lib/snapshot.ts` 每日快照
