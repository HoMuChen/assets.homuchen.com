import { db, type TwFuturesAccount } from "./db";
import { isTwFuturesOpen } from "./time";

// How long a synced SinoPac reading counts as fresh before an opportunistic refresh re-fetches it.
const TTL_MS = { open: 5 * 60_000, closed: 60 * 60_000 };
/**
 * After a failed sync, wait this long before the next opportunistic one. Open pages poll every 30s and each
 * failed sidecar call may re-login; SinoPac caps logins at 1,000/day. Forced refreshes ignore this.
 */
const FAILURE_BACKOFF_MS = 5 * 60_000;
const g = globalThis as unknown as { __sinopacFailedAt?: number };

type SidecarAccount = {
  account_id: string;
  equity: number;
  future_open_position: number;
  option_open_position: number;
  available_margin: number;
  initial_margin: number;
  maintenance_margin: number;
  risk_indicator: number;
  margin_call: number;
};

/** The Shioaji sidecar (sinopac/server.py); unset in local dev, which disables syncing. */
const sidecarUrl = () => process.env.SINOPAC_URL;

export function sinopacConfigured(): boolean {
  return !!sidecarUrl();
}

function sinopacRows(): TwFuturesAccount[] {
  return db().prepare("SELECT * FROM tw_futures_accounts WHERE source = 'sinopac' ORDER BY id").all() as TwFuturesAccount[];
}

export function sinopacStale(): boolean {
  if (g.__sinopacFailedAt && Date.now() - g.__sinopacFailedAt < FAILURE_BACKOFF_MS) return false;
  const ttl = isTwFuturesOpen() ? TTL_MS.open : TTL_MS.closed;
  return sinopacRows().some((r) => !r.synced_at || Date.now() - new Date(r.synced_at).getTime() > ttl);
}

/**
 * Pull 權益數 for every 'sinopac' account from the sidecar. A row without account_ref claims the first
 * futures account not already claimed. Failures are recorded on the rows (sync_error) and the last good
 * equity is kept, so a sidecar outage never zeroes net worth.
 */
export async function syncSinopac(): Promise<{ synced: number; error: string | null }> {
  const rows = sinopacRows();
  const url = sidecarUrl();
  if (rows.length === 0 || !url) return { synced: 0, error: null };

  const setError = db().prepare("UPDATE tw_futures_accounts SET sync_error = ? WHERE id = ?");
  let accounts: SidecarAccount[];
  try {
    const res = await fetch(`${url}/margin`, { cache: "no-store", signal: AbortSignal.timeout(40_000) });
    const body = (await res.json()) as { accounts?: SidecarAccount[]; error?: string };
    if (!res.ok || !body.accounts) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
    accounts = body.accounts;
  } catch (e) {
    const msg = `永豐 API：${(e as Error).message}`;
    rows.forEach((r) => setError.run(msg, r.id));
    g.__sinopacFailedAt = Date.now();
    return { synced: 0, error: msg };
  }

  const update = db().prepare(
    `UPDATE tw_futures_accounts SET account_ref=@account_ref, equity=@equity, open_pnl=@open_pnl,
       available_margin=@available_margin, initial_margin=@initial_margin, maintenance_margin=@maintenance_margin,
       risk_indicator=@risk_indicator, margin_call=@margin_call, synced_at=@synced_at, sync_error=NULL
     WHERE id=@id`,
  );
  const claimed = new Set(rows.map((r) => r.account_ref).filter(Boolean));
  const syncedAt = new Date().toISOString();
  const errors: string[] = [];
  let synced = 0;
  db().transaction(() => {
    for (const r of rows) {
      const a = r.account_ref
        ? accounts.find((x) => x.account_id === r.account_ref)
        : accounts.find((x) => !claimed.has(x.account_id));
      if (!a) {
        const msg = r.account_ref ? `永豐 API 找不到期貨帳號 ${r.account_ref}` : "永豐 API 沒有可對應的期貨帳號";
        setError.run(msg, r.id);
        errors.push(msg);
        continue;
      }
      claimed.add(a.account_id);
      update.run({
        id: r.id,
        account_ref: a.account_id,
        equity: a.equity,
        open_pnl: a.future_open_position + a.option_open_position,
        available_margin: a.available_margin,
        initial_margin: a.initial_margin,
        maintenance_margin: a.maintenance_margin,
        risk_indicator: a.risk_indicator,
        margin_call: a.margin_call,
        synced_at: syncedAt,
      });
      synced++;
    }
  })();
  g.__sinopacFailedAt = errors.length ? Date.now() : undefined;
  return { synced, error: errors.length ? errors.join("；") : null };
}
