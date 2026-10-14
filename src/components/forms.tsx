"use client";

import { useState } from "react";
import { saveCash, saveCrypto, saveFuturesAccount, saveFuturesPosition, saveProperty, saveStock, saveTwFutures } from "@/lib/actions";
import type { CashAccount, CryptoHolding, FuturesAccount, FuturesPosition, Property, StockHolding, TwFuturesAccount } from "@/lib/db";
import { Field, FormDialog, inputCls } from "./form-dialog";

const v = (x: unknown) => (x == null ? "" : String(x));

export function CashForm({ item }: { item?: CashAccount }) {
  return (
    <FormDialog title={item ? "編輯現金帳戶" : "新增現金帳戶"} action={saveCash} trigger={item ? "edit" : "add"} deleteKind="cash" deleteId={item?.id}>
      <input type="hidden" name="id" value={v(item?.id)} />
      <Field label="帳戶名稱">
        <input name="name" required defaultValue={v(item?.name)} placeholder="薪轉戶" className={inputCls} />
      </Field>
      <Field label="銀行 / 機構">
        <input name="institution" defaultValue={v(item?.institution)} placeholder="國泰世華" className={inputCls} />
      </Field>
      <Field label="幣別" hint="非 TWD 會以即時匯率換算">
        <input name="currency" required defaultValue={item?.currency ?? "TWD"} maxLength={3} className={`${inputCls} uppercase`} />
      </Field>
      <Field label="餘額">
        <input name="balance" required inputMode="decimal" defaultValue={v(item?.balance)} className={`${inputCls} num`} />
      </Field>
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </FormDialog>
  );
}

export function StockForm({ item }: { item?: StockHolding }) {
  return (
    <FormDialog title={item ? `編輯 ${item.symbol} ${item.name ?? ""}` : "新增台股持股"} action={saveStock} trigger={item ? "edit" : "add"} deleteKind="stock" deleteId={item?.id}>
      <input type="hidden" name="id" value={v(item?.id)} />
      <Field label="股票代號" hint="名稱會自動從 FinMind 帶入">
        <input name="symbol" required defaultValue={v(item?.symbol)} placeholder="2330" className={`${inputCls} num`} />
      </Field>
      <Field label="股數" hint="1 張 = 1,000 股">
        <input name="shares" required inputMode="decimal" defaultValue={v(item?.shares)} className={`${inputCls} num`} />
      </Field>
      <Field label="平均成本（每股）" hint="選填，用來計算未實現損益">
        <input name="avg_cost" inputMode="decimal" defaultValue={v(item?.avg_cost)} className={`${inputCls} num`} />
      </Field>
      <Field label="券商">
        <input name="broker" defaultValue={v(item?.broker)} placeholder="永豐金" className={inputCls} />
      </Field>
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </FormDialog>
  );
}

export function CryptoForm({ item }: { item?: CryptoHolding }) {
  return (
    <FormDialog
      title={item ? `編輯 ${item.symbol}` : "新增現貨"}
      action={saveCrypto}
      trigger={item ? "edit" : "addSubtle"}
      triggerLabel={item ? undefined : "新增現貨"}
      deleteKind="crypto"
      deleteId={item?.id}
    >
      <input type="hidden" name="id" value={v(item?.id)} />
      <Field label="幣種" hint="輸入代號（BTC）或 CoinGecko id（bitcoin）">
        <input name="coin" required defaultValue={v(item?.coin_id)} placeholder="BTC" className={inputCls} />
      </Field>
      <Field label="數量">
        <input name="amount" required inputMode="decimal" defaultValue={v(item?.amount)} className={`${inputCls} num`} />
      </Field>
      <Field label="平均成本（每顆，TWD）" hint="選填">
        <input name="avg_cost_twd" inputMode="decimal" defaultValue={v(item?.avg_cost_twd)} className={`${inputCls} num`} />
      </Field>
      <Field label="存放位置">
        <input name="location" defaultValue={v(item?.location)} placeholder="冷錢包 / Binance" className={inputCls} />
      </Field>
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </FormDialog>
  );
}

export function FuturesAccountForm({ item }: { item?: FuturesAccount }) {
  return (
    <FormDialog
      title={item ? `編輯 ${item.name}` : "新增合約帳戶"}
      action={saveFuturesAccount}
      trigger={item ? "edit" : "addSubtle"}
      triggerLabel={item ? undefined : "新增合約帳戶"}
      deleteKind="futuresAccount"
      deleteId={item?.id}
    >
      <input type="hidden" name="id" value={v(item?.id)} />
      <Field label="帳戶名稱" wide>
        <input name="name" required defaultValue={v(item?.name)} placeholder="Binance U 本位" className={inputCls} />
      </Field>
      <Field label="錢包餘額 (USDT)" hint="交易所顯示的「錢包餘額」，不含未實現損益" wide>
        <input name="wallet_balance" required inputMode="decimal" defaultValue={v(item?.wallet_balance)} className={`${inputCls} num`} />
      </Field>
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
      {item && <p className="text-[11px] text-fg-4 sm:col-span-2">刪除帳戶會一併刪除底下所有部位。</p>}
    </FormDialog>
  );
}

export function FuturesPositionForm({ accountId, item }: { accountId: number; item?: FuturesPosition }) {
  return (
    <FormDialog
      title={item ? `編輯 ${item.symbol} ${item.side === "long" ? "多單" : "空單"}` : "新增合約部位"}
      action={saveFuturesPosition}
      trigger={item ? "edit" : "addSubtle"}
      triggerLabel={item ? undefined : "新增部位"}
      deleteKind="futuresPosition"
      deleteId={item?.id}
    >
      <input type="hidden" name="id" value={v(item?.id)} />
      <input type="hidden" name="account_id" value={accountId} />
      <Field label="幣種" hint="輸入代號（BTC）或 CoinGecko id">
        <input name="coin" required defaultValue={v(item?.coin_id)} placeholder="BTC" className={inputCls} />
      </Field>
      <Field label="方向">
        <select name="side" defaultValue={item?.side ?? "long"} className={inputCls}>
          <option value="long">多 Long</option>
          <option value="short">空 Short</option>
        </select>
      </Field>
      <Field label="數量（幣）" hint="以幣計，例如 0.5 BTC">
        <input name="quantity" required inputMode="decimal" defaultValue={v(item?.quantity)} className={`${inputCls} num`} />
      </Field>
      <Field label="開倉均價 (USDT)">
        <input name="entry_price" required inputMode="decimal" defaultValue={v(item?.entry_price)} className={`${inputCls} num`} />
      </Field>
      <Field label="槓桿倍數" hint="選填，用來算報酬率 (ROE)">
        <input name="leverage" inputMode="decimal" defaultValue={v(item?.leverage)} placeholder="10" className={`${inputCls} num`} />
      </Field>
      <Field label="備註">
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </FormDialog>
  );
}

export function TwFuturesForm({ item, sinopacAvailable }: { item?: TwFuturesAccount; sinopacAvailable: boolean }) {
  return (
    <FormDialog title={item ? `編輯 ${item.name}` : "新增期貨帳戶"} action={saveTwFutures} trigger={item ? "edit" : "add"} deleteKind="twFutures" deleteId={item?.id}>
      <TwFuturesFields item={item} sinopacAvailable={sinopacAvailable} />
    </FormDialog>
  );
}

/** Rendered inside the dialog's form, which remounts on every open, so the source choice resets with it. */
function TwFuturesFields({ item, sinopacAvailable }: { item?: TwFuturesAccount; sinopacAvailable: boolean }) {
  const [source, setSource] = useState<TwFuturesAccount["source"]>(item?.source ?? "manual");
  return (
    <>
      <input type="hidden" name="id" value={v(item?.id)} />
      <Field label="帳戶名稱">
        <input name="name" required defaultValue={v(item?.name)} placeholder="台新期貨" className={inputCls} />
      </Field>
      <Field label="券商">
        <input name="broker" defaultValue={v(item?.broker)} placeholder="台新期貨" className={inputCls} />
      </Field>
      <Field label="資料來源" hint={sinopacAvailable ? undefined : "伺服器未設定永豐 API，只能手動輸入"} wide>
        <select name="source" value={source} onChange={(e) => setSource(e.target.value as TwFuturesAccount["source"])} className={inputCls}>
          <option value="manual">手動輸入</option>
          <option value="sinopac" disabled={!sinopacAvailable}>
            永豐 API（自動同步權益數）
          </option>
        </select>
      </Field>
      {source === "manual" ? (
        <Field label="權益數" hint="券商顯示的「權益數」，含未平倉損益" wide>
          <input name="equity" required inputMode="decimal" defaultValue={v(item?.equity)} className={`${inputCls} num`} />
        </Field>
      ) : (
        <p className="text-[11px] text-fg-4 sm:col-span-2">權益數、未平倉損益、保證金由永豐 API 定時同步（交易時段每 5 分鐘、其餘每小時）。</p>
      )}
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </>
  );
}

export function PropertyForm({ item }: { item?: Property }) {
  return (
    <FormDialog title={item ? `編輯 ${item.name}` : "新增房地產"} action={saveProperty} trigger={item ? "edit" : "add"} deleteKind="property" deleteId={item?.id}>
      <input type="hidden" name="id" value={v(item?.id)} />
      <Field label="名稱" wide>
        <input name="name" required defaultValue={v(item?.name)} placeholder="信義區自住" className={inputCls} />
      </Field>
      <Field label="投入現金" hint="頭期款、裝潢、稅費等自備款合計">
        <input name="cash_invested" required inputMode="decimal" defaultValue={v(item?.cash_invested)} className={`${inputCls} num`} />
      </Field>
      <Field label="估計市值" hint="選填；空白則以 投入現金 + 貸款金額 計">
        <input name="estimated_value" inputMode="decimal" defaultValue={v(item?.estimated_value)} className={`${inputCls} num`} />
      </Field>
      <Field label="貸款金額">
        <input name="loan_amount" required inputMode="decimal" defaultValue={v(item?.loan_amount ?? 0)} className={`${inputCls} num`} />
      </Field>
      <Field label="年利率 (%)">
        <input name="annual_rate" required inputMode="decimal" defaultValue={v(item?.annual_rate ?? 2.185)} className={`${inputCls} num`} />
      </Field>
      <Field label="貸款年限（年）">
        <input name="term_years" required inputMode="decimal" defaultValue={item ? v(item.term_months / 12) : "30"} className={`${inputCls} num`} />
      </Field>
      <Field label="寬限期（月）">
        <input name="grace_months" inputMode="numeric" defaultValue={v(item?.grace_months ?? 0)} className={`${inputCls} num`} />
      </Field>
      <Field label="撥款日" hint="用來自動計算目前剩餘本金">
        <input name="loan_start_date" type="date" defaultValue={v(item?.loan_start_date)} className={`${inputCls} num`} />
      </Field>
      <Field label="剩餘本金（手動覆寫）" hint="選填；有提前還款時填入銀行實際數字">
        <input name="balance_override" inputMode="decimal" defaultValue={v(item?.balance_override)} className={`${inputCls} num`} />
      </Field>
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </FormDialog>
  );
}
