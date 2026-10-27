// Taiwan broker exports (成交明細 / 對帳單 for trades, 庫存 for holdings) as CSV. Column names differ by broker,
// so each field is found by the names brokers use for it. Files saved from Excel are often Big5, and wrap codes
// as ="2330" to keep leading zeros.

export class CsvError extends Error {}

export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("big5").decode(bytes);
  }
}

/** RFC 4180 with the delimiter guessed (comma, tab or semicolon); cells trimmed, ="…" unwrapped. */
export function parseCsv(text: string): string[][] {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10).join("\n");
  const count = (c: string) => sample.split(c).length;
  const delim = [",", "\t", ";"].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (c === delim) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map(clean)).filter((r) => r.some((c) => c !== ""));
}

const clean = (s: string) => {
  const t = s.trim();
  const m = t.match(/^="(.*)"$/) ?? t.match(/^=(.*)$/);
  return (m ? m[1] : t).trim();
};

// ---------- columns ----------

/** Names each field goes by, most specific first. Headers are compared without spaces and unit suffixes. */
const FIELDS = {
  date: ["成交日期", "交易日期", "買賣日期", "成交日", "日期"],
  symbol: ["股票代號", "證券代號", "商品代號", "股票代碼", "證券代碼", "代號", "代碼", "股號"],
  name: ["股票名稱", "證券名稱", "商品名稱", "股名", "名稱"],
  side: ["買賣別", "交易別", "交易類別", "交易種類", "買/賣", "買賣", "委託別", "種類", "類別"],
  quantity: ["成交股數", "股數", "成交數量", "數量"],
  lots: ["成交張數", "張數"],
  price: ["成交價", "成交單價", "成交價格", "成交均價", "單價", "價格"],
  fee: ["手續費"],
  tax: ["交易稅", "證交稅", "交易稅額", "稅額"],
  held: ["庫存股數", "持有股數", "現股庫存", "庫存數量", "集保庫存", "目前庫存", "庫存", "持股"],
  avgCost: ["成本均價", "持有成本均價", "平均成本", "買進均價", "均價"],
} as const;
type Field = keyof typeof FIELDS;

const norm = (h: string) =>
  h
    .replace(/\s+/g, "")
    .replace(/[(（][^)）]*[)）]/g, "")
    .replace(/[:：]$/, "");

function columns(header: string[]): Partial<Record<Field, number>> {
  const names = header.map(norm);
  const out: Partial<Record<Field, number>> = {};
  const taken = new Set<number>();
  for (const field of Object.keys(FIELDS) as Field[]) {
    for (const syn of FIELDS[field]) {
      const i = names.findIndex((n, j) => !taken.has(j) && n === syn);
      if (i >= 0) {
        out[field] = i;
        taken.add(i);
        break;
      }
    }
  }
  return out;
}

// ---------- values ----------

/** 2026/10/27, 2026-10-27, 20261027, 民國 115/10/27; a time after the date is ignored. */
export function parseDate(s: string): string | null {
  const t = s.trim().split(/[\sT]/)[0];
  let m = t.match(/^(\d{8})$/);
  if (m) return valid(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`);
  m = t.match(/^(\d{2,4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?$/);
  if (!m) return null;
  const year = Number(m[1]) < 1911 ? Number(m[1]) + 1911 : Number(m[1]);
  return valid(`${year}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
}

const valid = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
};

/** "1,000"、"$1,234.5"、"(20)" → numbers; blank → null. */
export function parseNumber(s: string | undefined): number | null {
  if (s == null) return null;
  const t = s.replace(/[,\s$元股]/g, "");
  if (t === "" || t === "-") return null;
  const neg = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[()]/g, ""));
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

/** The leading stock code of a cell such as "2330" or "2330 台積電". */
const code = (s: string) => s.trim().toUpperCase().match(/^(\d{4,6}[A-Z]?)/)?.[1] ?? null;

// Margin trading (融資／融券) settles differently from cash shares; the ledger only follows cash shares.
const CREDIT = /融|資買|資賣|券買|券賣|借券/;

// ---------- parsing ----------

export type TradeRow = {
  line: number;
  date: string;
  symbol: string;
  name: string | null;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  /** As the broker charged them; null = not in the file. */
  fee: number | null;
  tax: number | null;
};
export type HoldingRow = { line: number; symbol: string; name: string | null; quantity: number; avgCost: number | null };
export type RowError = { line: number; message: string };

export type ParsedCsv =
  | { kind: "trades"; rows: TradeRow[]; errors: RowError[]; columns: string[] }
  | { kind: "holdings"; rows: HoldingRow[]; errors: RowError[]; columns: string[] };

export function parseBrokerCsv(text: string): ParsedCsv {
  const table = parseCsv(text);
  // The header is the first row naming a stock code column and either trades' or holdings' columns.
  const at = table.slice(0, 30).findIndex((r) => {
    const c = columns(r);
    return c.symbol != null && ((c.date != null && c.side != null && c.price != null) || c.held != null || c.quantity != null);
  });
  if (at < 0) {
    const first = table.slice(0, 3).map((r) => r.join("、")).join(" / ");
    throw new CsvError(`認不出欄位：需要「股票代號」，以及「成交日期、買賣別、成交價、成交股數」或「庫存股數」。檔案開頭是：${first || "（空的）"}`);
  }
  const header = table[at];
  const c = columns(header);
  const used = (Object.keys(c) as Field[]).map((f) => header[c[f]!]);
  const cell = (r: string[], f: Field) => (c[f] == null ? undefined : r[c[f]!]);
  const errors: RowError[] = [];
  const body = table.slice(at + 1).map((r, i) => ({ r, line: at + i + 2 }));

  if (c.date != null && c.side != null && c.price != null && (c.quantity != null || c.lots != null)) {
    const rows: TradeRow[] = [];
    for (const { r, line } of body) {
      const symbol = code(cell(r, "symbol") ?? "");
      if (!symbol) continue; // totals, notes, blank lines
      const side = cell(r, "side") ?? "";
      if (CREDIT.test(side)) {
        errors.push({ line, message: `${symbol} ${side}：信用交易（融資／融券）不支援，請另外記` });
        continue;
      }
      const dir = /買/.test(side) ? "buy" : /賣/.test(side) ? "sell" : null;
      const date = parseDate(cell(r, "date") ?? "");
      const lots = parseNumber(cell(r, "lots"));
      const quantity = parseNumber(cell(r, "quantity")) ?? (lots == null ? null : lots * 1000);
      const price = parseNumber(cell(r, "price"));
      const problem = !dir ? `看不懂買賣別「${side}」` : !date ? `看不懂日期「${cell(r, "date")}」` : !(quantity && quantity > 0) ? "股數要大於 0" : !(price && price > 0) ? "成交價要大於 0" : null;
      if (problem) {
        errors.push({ line, message: `${symbol}：${problem}` });
        continue;
      }
      const fee = parseNumber(cell(r, "fee"));
      const tax = parseNumber(cell(r, "tax"));
      rows.push({ line, date: date!, symbol, name: cell(r, "name") || null, side: dir!, quantity: quantity!, price: price!, fee: fee == null ? null : Math.abs(fee), tax: tax == null ? null : Math.abs(tax) });
    }
    return { kind: "trades", rows, errors, columns: used };
  }

  // A holdings file may call the count just 股數.
  if (c.held == null) c.held = c.quantity;
  const rows = new Map<string, HoldingRow>();
  for (const { r, line } of body) {
    const symbol = code(cell(r, "symbol") ?? "");
    if (!symbol) continue;
    if (r.some((x) => CREDIT.test(x))) {
      errors.push({ line, message: `${symbol}：信用交易（融資／融券）的庫存不計入` });
      continue;
    }
    const quantity = parseNumber(cell(r, "held"));
    if (quantity == null || quantity < 0) {
      errors.push({ line, message: `${symbol}：看不懂庫存股數「${cell(r, "held") ?? ""}」` });
      continue;
    }
    // A stock listed twice (e.g. board lots and odd lots) is one holding.
    const prev = rows.get(symbol);
    rows.set(symbol, prev ? { ...prev, quantity: prev.quantity + quantity } : { line, symbol, name: cell(r, "name") || null, quantity, avgCost: parseNumber(cell(r, "avgCost")) });
  }
  return { kind: "holdings", rows: [...rows.values()], errors, columns: used };
}
