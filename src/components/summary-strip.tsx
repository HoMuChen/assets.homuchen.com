import type { ReactNode } from "react";
import { Card, Stat } from "./ui";

export function SummaryStrip({ items }: { items: { label: string; value: ReactNode; sub?: ReactNode }[] }) {
  return (
    <Card className={`grid grid-cols-2 divide-line md:divide-x ${items.length === 4 ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
      {items.map((i) => (
        <Stat key={i.label} {...i} />
      ))}
    </Card>
  );
}
