import type { Category } from "./portfolio";

/** Fixed order = validated categorical slot order; color follows the category, never its rank. */
export const CATEGORY_ORDER: Category[] = ["stocks", "crypto", "cash", "realEstate"];

export const CATEGORY_COLOR: Record<Category, string> = {
  stocks: "var(--series-1)",
  crypto: "var(--series-2)",
  cash: "var(--series-3)",
  realEstate: "var(--series-4)",
};

export const CATEGORY_HREF: Record<Category, string> = {
  stocks: "/stocks",
  crypto: "/crypto",
  cash: "/cash",
  realEstate: "/real-estate",
};
