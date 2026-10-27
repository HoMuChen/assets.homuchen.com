"use client";

import { useId, useState } from "react";
import { saveAccount, saveCash, saveFuturesAccount, saveFuturesPosition, saveProperty, saveTransaction, saveTwFutures } from "@/lib/actions";
import type { Account, FuturesAccount, FuturesPosition, Property, TwFuturesAccount, TxType } from "@/lib/db";
import { twTradeCosts } from "@/lib/fees";
import { fmtNum } from "@/lib/format";
import type { CashBalance, TxRow } from "@/lib/ledger";
import { assetId, TX_LABEL } from "@/lib/tx";
import { Field, FormDialog, inputCls } from "./form-dialog";

const v = (x: unknown) => (x == null ? "" : String(x));

export function CashForm({ item }: { item?: CashBalance }) {
  return (
    <FormDialog
      title={item ? "編輯現金帳戶" : "新增現金帳戶"}
      action={saveCash}
      trigger={item ? "edit" : "add"}
      deleteKind="account"
      deleteId={item?.accountId ?? undefined}
      deleteWarning="會一併刪除這個帳戶的餘額紀錄。"
    >
      <input type="hidden" name="id" value={v(item?.accountId)} />
      <Field label="帳戶名稱">
        <input name="name" required defaultValue={v(item?.name)} placeholder="薪轉戶" className={inputCls} />
      </Field>
      <Field label="銀行 / 機構">
        <input name="institution" defaultValue={v(item?.institution)} placeholder="國泰世華" className={inputCls} />
      </Field>
      <Field label="幣別" hint="非 TWD 會以即時匯率換算">
        <input name="currency" required defaultValue={item?.currency ?? "TWD"} maxLength={3} className={`${inputCls} uppercase`} />
      </Field>
      <Field label="餘額" hint={item ? "和上次不同時，會記一筆今天的調整" : undefined}>
        <input name="balance" required inputMode="decimal" defaultValue={v(item?.balance)} className={`${inputCls} num`} />
      </Field>
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </FormDialog>
  );
}

export type TxAccountOption = { name: string; feeDiscount: number | null };

const TX_TYPES: Record<"stock" | "crypto", TxType[]> = {
  stock: ["buy", "sell", "dividend", "adjust"],
  crypto: ["buy", "sell", "adjust"],
};

/** Record a stock or coin transaction, or edit one (`item`). `preset` pre-fills a new one from a holding row. */
export function TransactionForm({
  kind,
  accounts,
  today,
  item,
  preset,
  trigger = item ? "edit" : "add",
  triggerLabel,
}: {
  kind: "stock" | "crypto";
  accounts: TxAccountOption[];
  today: string;
  item?: TxRow;
  preset?: { account?: string; symbol?: string };
  trigger?: "add" | "addSubtle" | "edit";
  triggerLabel?: string;
}) {
  const title = item ? `編輯${TX_LABEL[item.type]}${item.symbol ? ` ${item.symbol}` : ""}` : kind === "stock" ? "記一筆股票交易" : "記一筆加密貨幣交易";
  return (
    <FormDialog
      title={title}
      action={saveTransaction}
      trigger={trigger}
      triggerLabel={triggerLabel}
      deleteKind={item?.source === "manual" ? "transaction" : undefined}
      deleteId={item?.id}
    >
      <TxFields kind={kind} accounts={accounts} today={today} item={item} preset={preset} />
    </FormDialog>
  );
}

function TxFields({
  kind,
  accounts,
  today,
  item,
  preset,
}: {
  kind: "stock" | "crypto";
  accounts: TxAccountOption[];
  today: string;
  item?: TxRow;
  preset?: { account?: string; symbol?: string };
}) {
  const [type, setType] = useState<TxType>(item?.type ?? "buy");
  const [account, setAccount] = useState(item?.account_name ?? preset?.account ?? (accounts.length === 1 ? accounts[0].name : ""));
  const [symbol, setSymbol] = useState(item?.asset ? assetId(item.asset) : (preset?.symbol ?? ""));
  const [quantity, setQuantity] = useState(item ? v(item.type === "sell" ? -item.quantity : item.quantity) : "");
  const [price, setPrice] = useState(v(item?.price));
  const [date, setDate] = useState(item?.date ?? today);
  const listId = useId();
  const trade = type === "buy" || type === "sell";
  const unit = kind === "stock" ? "股" : "顆";

  // What the server fills in when fee / tax are left blank.
  const n = (s: string) => Number(s.replace(/,/g, ""));
  const auto =
    kind === "stock" && trade && n(quantity) > 0 && n(price) > 0
      ? twTradeCosts({
          side: type,
          symbol: symbol.trim().toUpperCase(),
          shares: n(quantity),
          price: n(price),
          date,
          feeDiscount: accounts.find((a) => a.name === account.trim())?.feeDiscount,
        })
      : { fee: 0, tax: 0 };

  return (
    <>
      <input type="hidden" name="id" value={v(item?.id)} />
      <input type="hidden" name="kind" value={kind} />
      <Field label={kind === "stock" ? "券商帳戶" : "交易所／錢包"} hint={accounts.length ? undefined : "輸入名稱，第一次使用會自動建立"}>
        <input
          name="account"
          required
          list={listId}
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          placeholder={accounts.length ? "選擇或輸入新帳戶名稱" : kind === "stock" ? "例如 國泰證券" : "例如 Bybit"}
          className={inputCls}
        />
        <datalist id={listId}>
          {accounts.map((a) => (
            <option key={a.name} value={a.name} />
          ))}
        </datalist>
      </Field>
      <Field label="類型">
        {type === "open" ? (
          <>
            <input type="hidden" name="type" value="open" />
            <span className="flex h-8 items-center text-[13px] text-fg-2">期初（帳本上線時的持有）</span>
          </>
        ) : (
          <select name="type" value={type} onChange={(e) => setType(e.target.value as TxType)} className={inputCls}>
            {TX_TYPES[kind].map((t) => (
              <option key={t} value={t}>
                {TX_LABEL[t]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={kind === "stock" ? "股票代號" : "幣種"} hint={kind === "crypto" ? "代號（BTC）或 CoinGecko id（bitcoin）" : undefined}>
        <input
          name="symbol"
          required
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          placeholder={kind === "stock" ? "2330" : "BTC"}
          className={`${inputCls} ${kind === "stock" ? "num" : ""}`}
        />
      </Field>
      <Field label="日期">
        <input name="date" type="date" required max={today} value={date} onChange={(e) => setDate(e.target.value)} className={`${inputCls} num`} />
      </Field>
      <Field
        label={type === "dividend" ? `配股（${unit}）` : type === "adjust" ? `增減數量（${unit}）` : `數量（${unit}）`}
        hint={
          type === "adjust"
            ? "增加填正數、減少填負數；新增的部分成本為 0（例如分割、配股），知道成本請改記「買進」"
            : type === "dividend"
              ? "選填，有配股才填"
              : kind === "stock"
                ? "1 張 = 1,000 股"
                : undefined
        }
      >
        <input
          name="quantity"
          required={type !== "dividend"}
          inputMode="decimal"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className={`${inputCls} num`}
        />
      </Field>
      {(trade || type === "open") && (
        <Field label={type === "open" ? "成本均價（每單位）" : "成交價（每單位）"} hint={kind === "crypto" ? "以台幣計" : type === "open" ? "選填，空白表示成本未知" : undefined}>
          <input
            name="price"
            required={trade}
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className={`${inputCls} num`}
          />
        </Field>
      )}
      {type === "dividend" && (
        <Field label="現金股利（總額）" hint="扣費用前的金額">
          <input
            name="gross"
            inputMode="decimal"
            defaultValue={item ? v(item.amount + item.fee + item.tax) : ""}
            className={`${inputCls} num`}
          />
        </Field>
      )}
      {(trade || type === "dividend") && (
        <Field label={kind === "crypto" ? "手續費（TWD）" : type === "dividend" ? "匯費" : "手續費"} hint={trade && kind === "stock" ? "空白會依帳戶折扣自動計算" : undefined}>
          <input
            name="fee"
            inputMode="decimal"
            defaultValue={v(item?.fee)}
            placeholder={trade && kind === "stock" ? `自動：${fmtNum(auto.fee, 0)}` : "0"}
            className={`${inputCls} num`}
          />
        </Field>
      )}
      {((type === "sell" && kind === "stock") || type === "dividend") && (
        <Field label={type === "sell" ? "證交稅" : "二代健保補充保費"} hint={type === "dividend" ? "單筆股利 2 萬以上會扣 2.11%" : undefined}>
          <input
            name="tax"
            inputMode="decimal"
            defaultValue={v(item?.tax)}
            placeholder={type === "sell" ? `自動：${fmtNum(auto.tax, 0)}` : "0"}
            className={`${inputCls} num`}
          />
        </Field>
      )}
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item?.note)} className={inputCls} />
      </Field>
    </>
  );
}

export function AccountForm({ item }: { item: Account }) {
  return (
    <FormDialog
      title={`編輯 ${item.name}`}
      action={saveAccount}
      trigger="edit"
      deleteKind="account"
      deleteId={item.id}
      deleteWarning="會一併刪除這個帳戶的所有交易紀錄與持股。"
    >
      <input type="hidden" name="id" value={item.id} />
      <Field label="帳戶名稱">
        <input name="name" required defaultValue={item.name} className={inputCls} />
      </Field>
      <Field label="機構">
        <input name="institution" defaultValue={v(item.institution)} className={inputCls} />
      </Field>
      {item.kind === "stock" && (
        <Field label="手續費折扣（折）" hint="例如 2.8 折填 2.8；空白 = 不打折。用來預填手續費" wide>
          <input
            name="fee_discount"
            inputMode="decimal"
            defaultValue={item.fee_discount == null ? "" : String(Math.round(item.fee_discount * 1000) / 100)}
            className={`${inputCls} num`}
          />
        </Field>
      )}
      <Field label="備註" wide>
        <input name="note" defaultValue={v(item.note)} className={inputCls} />
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
