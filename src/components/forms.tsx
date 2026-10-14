"use client";

import { saveCash, saveCrypto, saveProperty, saveStock } from "@/lib/actions";
import type { CashAccount, CryptoHolding, Property, StockHolding } from "@/lib/db";
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
    <FormDialog title={item ? `編輯 ${item.symbol}` : "新增加密貨幣"} action={saveCrypto} trigger={item ? "edit" : "add"} deleteKind="crypto" deleteId={item?.id}>
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
