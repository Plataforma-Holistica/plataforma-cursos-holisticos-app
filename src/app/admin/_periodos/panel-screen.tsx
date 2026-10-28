"use client";

import { useActionState, useEffect, useRef } from "react";

import { admin } from "@/messages/es/admin";
import { periodPath, ROUTES } from "@/services/account/navigation";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { DataTable } from "@/ui/data-table";
import { InlineAlert } from "@/ui/inline-alert";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";
import { StatTile } from "@/ui/stat-tile";
import { StatusBadge } from "@/ui/status-badge";
import { TextLink } from "@/ui/text-link";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { CodeBlock } from "../_lib/code-block";
import { panelAction, periodCodeAction } from "./actions";
import { FAILURES, toneOf } from "./failures";
import type { CodeState, PanelState } from "./outcomes";
import type { PeriodView, Tile } from "./rows";

// PA-79 · El panel de un periodo: si está sano y listo para cerrar. Las cifras salen del libro propio,
// del cierre o del último ensayo, con su fecha (el panel no calcula al abrirse). Las alertas abren
// PA-68. «Recalcular» deja un pedido en la base que un trabajo de cada minuto corre (decisión de Sergio
// del 2026-10-27). La conciliación con el proveedor de video llega con T-209, y la del cobro con T-303:
// mientras no existan, sus bloques no se muestran. Las liquidaciones (PA-81) llegan con la tercera
// solicitud de T-605.
//
// Todo funciona sin JavaScript: «Recalcular» es un formulario con su acción, y lo que sale bien
// redirige aquí con su aviso.

const text = admin.periods;
const CODE_IDLE: CodeState = { kind: "idle" };
const PANEL_IDLE: PanelState = { kind: "idle" };
// Las anclas de los bloques: `id` que ninguna otra pantalla usa.
const CODE_BLOCK_ID = "bloque-periodo-codigo";
const CODE_TITLE_ID = "periodo-codigo-titulo";
const CODE_FIELD_ID = "periodo-codigo";
const ROLLUP_BLOCK_ID = "bloque-periodo-recalculo";
const ROLLUP_HEADING_ID = "periodo-recalculo-titulo";

export interface PeriodScreenProps {
  view: PeriodView;
  /** La página llegó con el aviso de un recálculo pedido. */
  done?: boolean;
}

export function PeriodScreen({ view, done = false }: PeriodScreenProps) {
  const page = periodPath(view.periodId);
  const [code, codeAction, codePending] = useActionState(periodCodeAction.bind(null, { period: view.periodId, page: "panel" }), CODE_IDLE, `${page}#${CODE_BLOCK_ID}`);
  const [panel, sendPanel, panelPending] = useActionState(panelAction, PANEL_IDLE, `${page}#${ROLLUP_BLOCK_ID}`);
  const doneBox = useRef<HTMLDivElement>(null);

  // Llegó con el aviso: si el foco quedó sin dueño (el botón pulsado se fue), lo toma el aviso.
  useEffect(() => {
    if (done && (document.activeElement === null || document.activeElement === document.body)) doneBox.current?.focus();
  }, [done]);

  const attempt = panel.kind === "idle" ? 0 : panel.attempt;
  const failure =
    panelPending || panel.kind !== "failed"
      ? null
      : // Si la página ya leyó un código reciente (se dio después), pedirlo ya no es cierto.
        panel.reason === "needs_code" && view.canChange
        ? null
        : panel.reason;
  const result = failure === null ? null : FAILURES[failure];
  const { block, answer, spoken } = useAnswerFocus(panelPending, attempt, result);
  const showDone = done && panel.kind === "idle" && !panelPending;

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-page flex-col gap-10 px-4 py-16 outline-none">
      <div className="flex flex-col gap-3">
        <BackLink href={ROUTES.periods}>{text.backToPeriods}</BackLink>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-h1">{view.name}</h1>
          <StatusBadge tone={view.tone}>{view.status}</StatusBadge>
        </div>
        <ol aria-label={text.steps} className="flex flex-wrap gap-2 text-body-s text-text-2">
          {view.steps.map((step) => (
            <li key={step.label} aria-current={step.current ? "step" : undefined} className={step.current ? "font-semibold text-text" : undefined}>
              {step.label}
            </li>
          ))}
        </ol>
      </div>

      {!view.canChange && !view.readOnly && (
        <CodeBlock
          blockId={CODE_BLOCK_ID}
          titleId={CODE_TITLE_ID}
          fieldId={CODE_FIELD_ID}
          body={text.codeBody}
          notAvailable={text.codeNotAvailable}
          state={code}
          action={codeAction}
          pending={codePending}
        />
      )}

      {view.readOnly && <InlineAlert tone="neutral">{text.readOnly}</InlineAlert>}
      {view.alertsWarning !== null && (
        <InlineAlert tone="warning" action={<TextLink href={ROUTES.alerts}>{text.goToAlerts}</TextLink>}>
          {view.alertsWarning}
        </InlineAlert>
      )}

      <section aria-labelledby="periodo-cifras-titulo" className="flex flex-col gap-4">
        <h2 id="periodo-cifras-titulo" className="text-h2">
          {text.figuresTitle}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[view.collected, view.assigned, view.students, view.pool, view.poolPercent, view.unconsumed].map((tile) => (
            <Figure key={tile.label} tile={tile} />
          ))}
        </div>
        <p className="text-body-s text-text-2">{view.figuresSource}</p>
      </section>

      <section aria-labelledby="periodo-alertas-titulo" className="flex flex-col gap-4">
        <h2 id="periodo-alertas-titulo" className="text-h2">
          {text.alertsTitle}
        </h2>
        {view.alerts.kind === "unavailable" ? (
          <InlineAlert tone="warning" action={<TextLink href={ROUTES.alerts}>{text.goToAlerts}</TextLink>}>
            {text.alertsUnavailable}
          </InlineAlert>
        ) : (
          <DataTable
            caption={text.alertsCaption}
            captionHidden
            columns={[
              { key: "kind", header: text.alertColumns.kind },
              { key: "teacher", header: text.alertColumns.teacher },
              { key: "status", header: text.alertColumns.status },
            ]}
            rows={view.alerts.rows.map((row) => ({
              key: row.key,
              cells: {
                kind: <TextLink href={row.href}>{row.kind}</TextLink>,
                teacher: row.teacher,
                status: <StatusBadge tone={row.tone}>{row.status}</StatusBadge>,
              },
            }))}
            empty={text.alertsNone}
          />
        )}
      </section>

      <section ref={block} id={ROLLUP_BLOCK_ID} aria-labelledby={ROLLUP_HEADING_ID} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        <h2 id={ROLLUP_HEADING_ID} className="text-h2">
          {text.rollupTitle}
        </h2>
        <p>{view.rollup.last}</p>
        {view.rollup.failed !== null && (
          <InlineAlert tone="danger">
            {view.rollup.failed[0]}
            {SPACE}
            {view.rollup.failed[1]}
          </InlineAlert>
        )}
        {showDone && (
          <div ref={doneBox} tabIndex={-1} className="outline-none">
            <InlineAlert tone="success">{text.done.rollupRequested}</InlineAlert>
          </div>
        )}
        {view.rollup.request !== null && <p className="text-text-2">{view.rollup.request}</p>}
        <BlockResult
          message={result}
          tone={failure === null ? "warning" : toneOf(failure)}
          pending={panelPending}
          pendingText={text.recalculating}
          answer={answer}
          spoken={spoken}
        />
        {view.rollup.button !== null && (
          <form action={sendPanel} noValidate>
            <Button type="submit" variant="secondary" name="do" value={view.rollup.button} loading={panelPending} loadingLabel={text.recalculating}>
              {text.recalculate}
            </Button>
          </form>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <Button href={view.closeHref}>{text.rehearseAndClose}</Button>
      </div>

      <p className="text-body-s">
        <TextLink href={ROUTES.admin}>{text.backToAdmin}</TextLink>
      </p>
    </main>
  );
}

function Figure({ tile }: { tile: Tile }) {
  return <StatTile label={tile.label} value={tile.value} context={tile.context} tag={tile.tag} />;
}
