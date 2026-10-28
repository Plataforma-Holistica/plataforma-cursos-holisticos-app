import { admin } from "@/messages/es/admin";
import { ROUTES } from "@/services/account/navigation";
import { DataTable } from "@/ui/data-table";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { StatusBadge } from "@/ui/status-badge";
import { TextLink } from "@/ui/text-link";

import type { PeriodListRow } from "./rows";

// PA-78 · Los periodos: una tabla, el más reciente primero y el en curso arriba, marcado. Solo consulta:
// un periodo solo avanza, y la tabla no ofrece reabrir nada. Cada periodo se abre desde su nombre.

const text = admin.periods;

const COLUMNS = [
  { key: "period", header: text.columns.period },
  { key: "status", header: text.columns.status },
  { key: "students", header: text.columns.students, numeric: true },
  { key: "pool", header: text.columns.pool, numeric: true },
  { key: "percent", header: text.columns.percent, numeric: true },
  { key: "payouts", header: text.columns.payouts, numeric: true },
] as const;

export function PeriodsScreen({ view }: { view: { rows: PeriodListRow[] } }) {
  const rows = view.rows.map((row) => ({
    key: row.key,
    cells: {
      period: (
        <span className="flex flex-col gap-1">
          <TextLink href={row.href}>{row.name}</TextLink>
          {row.current && <span className="text-caption text-accent">{text.current}</span>}
        </span>
      ),
      status: <StatusBadge tone={row.tone}>{row.status}</StatusBadge>,
      students: row.students,
      pool: (
        <span className="flex flex-col gap-1">
          <span>{row.pool}</span>
          {row.source !== null && <span className="text-caption text-text-2">{row.source}</span>}
        </span>
      ),
      percent: row.percent,
      payouts: row.payouts,
    },
  }));
  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-8 px-4 py-16 outline-none">
      <div className="flex flex-col gap-2">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
      <DataTable caption={text.listCaption} captionHidden columns={COLUMNS} rows={rows} empty={text.empty} scroll />
      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}
