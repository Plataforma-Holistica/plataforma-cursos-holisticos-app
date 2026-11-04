import { ChevronRight } from "lucide";
import type { ReactNode } from "react";

import { portal } from "@/messages/es/portal";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { cx } from "@/ui/cx";
import { DataTable } from "@/ui/data-table";
import { Icon } from "@/ui/icon";
import { InlineAlert } from "@/ui/inline-alert";
import { StatTile } from "@/ui/stat-tile";
import { StatusBadge } from "@/ui/status-badge";
import { TextLink } from "@/ui/text-link";

import { PortalFrame } from "../_lib/frame";
import { CsvDownload } from "./download";
import { DOWNLOAD_BLOCK_ID } from "./outcomes";
import type { PayoutRowView, PayoutsView, ReportView } from "./rows";

// PA-46 · Pagos y PA-47 · Liquidación del periodo (T-604, cuarta solicitud), de solo lectura: la subida de la factura llega con la siguiente solicitud.
// Lo pinta la sección después de la guarda, con la vista ya en palabras (`rows.ts`). El maestro suspendido ve todo; la franja la pone el marco.

const text = portal.payouts;

// ---------------------------------------------------------------------------------------
// PA-46.

function RowAction({ row }: { row: PayoutRowView }) {
  return (
    <span className="flex flex-col gap-1">
      {row.canInvoice ? (
        <TextLink href={row.href}>
          <span aria-hidden="true">{text.canInvoice}</span>
          <span className="sr-only">{t(text.canInvoiceNamed, { period: row.period })}</span>
        </TextLink>
      ) : (
        <TextLink href={row.href}>
          <span aria-hidden="true">{text.open}</span>
          <span className="sr-only">{t(text.openNamed, { period: row.period })}</span>
        </TextLink>
      )}
      {row.overdue && <span className="text-caption text-text-2">{text.overdueShort}</span>}
    </span>
  );
}

function RowStatus({ row }: { row: PayoutRowView }) {
  return (
    <span className="flex flex-col gap-1">
      <StatusBadge tone={row.status.tone}>{row.status.label}</StatusBadge>
      {row.carried !== null && <span className="text-caption text-text-2">{row.carried}</span>}
    </span>
  );
}

const COLUMNS = [
  { key: "period", header: text.columns.period },
  { key: "status", header: text.columns.status },
  { key: "pool", header: text.columns.pool, numeric: true },
  { key: "extras", header: text.columns.extras, numeric: true },
  { key: "net", header: text.columns.net, numeric: true },
  { key: "action", header: text.columns.action },
] as const;

export function PayoutsScreen({ view, readOnly }: { view: PayoutsView; readOnly: boolean }) {
  return (
    <PortalFrame current={ROUTES.portalPayouts} readOnly={readOnly}>
      <div className="flex max-w-reading flex-col gap-3">
        <h1 className="text-h1">{text.title}</h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
      {view.taxDataMissing && (
        <InlineAlert tone="warning">
          {text.taxDataMissing} <TextLink href={ROUTES.portalTaxData}>{text.taxDataLink}</TextLink>
        </InlineAlert>
      )}
      {view.balance !== null && (
        <div className="max-w-xs">
          <StatTile label={text.balance} value={view.balance.amount} context={view.balance.context} />
        </div>
      )}
      {view.rows.length === 0 ? (
        <p className="text-text-2">{text.empty}</p>
      ) : (
        <>
          {/* Escritorio: la tabla. Teléfono: tarjetas, la más reciente primero, con la acción a todo el ancho. */}
          <div className="hidden md:block">
            <DataTable
              caption={text.caption}
              captionHidden
              columns={COLUMNS}
              rows={view.rows.map((row) => ({
                key: row.key,
                cells: {
                  period: row.period,
                  status: <RowStatus row={row} />,
                  pool: row.pool,
                  extras: row.extras,
                  net: row.net,
                  action: <RowAction row={row} />,
                },
              }))}
              empty={text.empty}
            />
          </div>
          <ul aria-label={text.caption} className="flex flex-col gap-4 md:hidden">
            {view.rows.map((row) => (
              <li key={row.key} className="flex flex-col gap-3 rounded-md border border-border p-4">
                <p className="font-semibold">{row.period}</p>
                <RowStatus row={row} />
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-body-s">
                  <dt className="text-text-2">{text.columns.pool}</dt>
                  <dd className="text-right tabular-nums">{row.pool}</dd>
                  <dt className="text-text-2">{text.columns.extras}</dt>
                  <dd className="text-right tabular-nums">{row.extras}</dd>
                  <dt className="text-text-2">{text.columns.net}</dt>
                  <dd className="text-right tabular-nums">{row.net}</dd>
                </dl>
                <div className="flex min-h-touch w-full items-center">
                  <RowAction row={row} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </PortalFrame>
  );
}

// ---------------------------------------------------------------------------------------
// PA-47.

function Steps({ view }: { view: ReportView }) {
  if (view.step === null) return null;
  return (
    <ol aria-label={text.steps} className="flex flex-wrap gap-x-2 gap-y-1 text-body-s">
      {view.steps.map((each, index) => (
        <li key={each.step} aria-current={each.step === view.step ? "step" : undefined} className="flex items-center gap-2">
          {index > 0 && <Icon icon={ChevronRight} className="text-text-3" />}
          <span className={cx(each.step === view.step ? "rounded-sm border border-accent px-2 font-semibold text-text" : "text-text-2")}>{each.label}</span>
        </li>
      ))}
    </ol>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-titulo`} className="flex flex-col gap-4">
      <h2 id={`${id}-titulo`} className="text-h2">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Amounts({ lines }: { lines: readonly { key: string; label: string; amount: string; total?: boolean }[] }) {
  return (
    <dl className="flex max-w-reading flex-col">
      {lines.map((line) => (
        <div key={line.key} className={cx("flex justify-between gap-4 py-1", line.total === true && "border-t border-border pt-2 font-semibold")}>
          <dt>{line.label}</dt>
          <dd className="tabular-nums">{line.amount}</dd>
        </div>
      ))}
    </dl>
  );
}

const STUDENT_COLUMNS = [
  { key: "student", header: text.studentColumns.student },
  { key: "points", header: text.studentColumns.points, numeric: true },
  { key: "pesos", header: text.studentColumns.pesos, numeric: true },
] as const;

export function ReportScreen({ view, page, readOnly }: { view: ReportView; page: string; readOnly: boolean }) {
  return (
    <PortalFrame current={ROUTES.portalPayouts} readOnly={readOnly}>
      <div className="flex flex-col gap-3">
        <BackLink href={ROUTES.portalPayouts}>{text.back}</BackLink>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-h1">{view.title}</h1>
          <StatusBadge tone={view.status.tone}>{view.status.label}</StatusBadge>
        </div>
        <Steps view={view} />
      </div>

      <section aria-labelledby="que-sigue-titulo" className="flex flex-col gap-3 rounded-md border border-border p-4">
        <h2 id="que-sigue-titulo" className="text-h3">
          {text.next.title}
        </h2>
        <p>{view.next.text}</p>
        {view.next.taxDataLink && (
          <p>
            <TextLink href={ROUTES.portalTaxData}>{text.taxDataLink}</TextLink>
          </p>
        )}
        {view.overdue !== null && <InlineAlert tone="warning">{view.overdue}</InlineAlert>}
      </section>

      <Section id="resumen" title={text.summaryTitle}>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile label={text.pool} value={view.summary.pool} />
          <StatTile label={text.poolBps} value={view.summary.poolBps} />
          <StatTile label={text.share} value={view.summary.share} />
        </div>
        {view.summary.nothingAssigned && <p className="text-text-2">{t(text.nothingAssigned)}</p>}
      </Section>

      {view.money !== null && (
        <Section id="desglose" title={text.moneyTitle}>
          <Amounts lines={view.money} />
        </Section>
      )}

      {view.invoice !== null && (
        <Section id="factura" title={text.invoiceTitle}>
          {view.invoice.receiverRfc === null ? (
            <InlineAlert tone="warning">{t(text.receiverMissing)}</InlineAlert>
          ) : (
            <p className="break-words">{t(text.receiver, { rfc: view.invoice.receiverRfc })}</p>
          )}
          <Amounts lines={view.invoice.amounts.map((line) => ({ ...line, total: line.key === "total" }))} />
          <div className="flex flex-col gap-1">
            <h3 className="text-h3">{text.latestTitle}</h3>
            {view.invoice.latest === null ? (
              <p className="text-text-2">{text.noInvoice}</p>
            ) : (
              <>
                <p className="font-semibold">{view.invoice.latest.status}</p>
                <p className="text-body-s text-text-2">{view.invoice.latest.submitted}</p>
                {view.invoice.latest.reviewed !== null && <p className="text-body-s text-text-2">{view.invoice.latest.reviewed}</p>}
                {view.invoice.latest.reason !== null && <p className="break-words">{view.invoice.latest.reason}</p>}
              </>
            )}
          </div>
        </Section>
      )}

      {view.payment !== null && (
        <Section id="pago" title={text.paymentTitle}>
          <Amounts
            lines={[
              { key: "fecha", label: text.paidOn, amount: view.payment.paidOn },
              { key: "referencia", label: text.reference, amount: view.payment.reference },
              { key: "neto", label: text.paidAmount, amount: view.payment.amount, total: true },
            ]}
          />
        </Section>
      )}

      <Section id="alumnos" title={text.studentsTitle}>
        <p className="max-w-reading text-text-2">{t(text.aliasNote)}</p>
        {view.students.length === 0 && <p className="text-text-2">{text.noStudents}</p>}
        {/* Por alumno, el alias y los puntos: la celda de pesos va vacía. Los pesos, solo en el bote sin consumo y en el total. */}
        <DataTable
          caption={text.studentsCaption}
          captionHidden
          columns={STUDENT_COLUMNS}
          rows={[
            ...view.students.map((student) => ({ key: `alumno-${student.key}`, cells: { student: student.alias, points: student.points, pesos: null } })),
            { key: "sin-consumo", cells: { student: text.unconsumed, points: null, pesos: view.unconsumed } },
          ]}
          empty={text.noStudents}
          totals={{ student: text.total, points: view.totalPoints, pesos: view.total }}
        />
      </Section>

      <section id={DOWNLOAD_BLOCK_ID} aria-labelledby="descargas-titulo" className="flex flex-col gap-3">
        <h2 id="descargas-titulo" className="text-h2">
          {text.downloadTitle}
        </h2>
        <CsvDownload period={view.period} page={page} />
      </section>
    </PortalFrame>
  );
}
