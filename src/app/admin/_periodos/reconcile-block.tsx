"use client";

import { type RefObject, useActionState, useState } from "react";

import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { periodPath } from "@/services/account/navigation";
import { Button } from "@/ui/button";
import { DataTable } from "@/ui/data-table";
import { InlineAlert } from "@/ui/inline-alert";
import { Textarea } from "@/ui/textarea";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { reconcileAction } from "./actions";
import { PANEL_ANCHORS } from "./outcomes";
import { answerTone, RECONCILE_ANSWERS, RECONCILE_FAILURES, reconcileToneOf } from "./reconcile-failures";
import { NOTE_MAX, reconcileButton, type ReconcileState } from "./reconcile-outcomes";
import type { DifferenceRow, ReconciliationView } from "./reconcile-rows";

// El bloque «Conciliación con Stripe» de PA-79 (T-303, cuarta solicitud; RF-208, RF-501): la última comparación de los cobros del periodo con los cargos de Stripe,
// sus diferencias, «Comparar ahora» y «Explicar». Para cerrar, la última tiene que coincidir y estar vigente; PA-80 enlaza aquí por su ancla.
//
// Todo funciona sin JavaScript: «Comparar ahora» es un formulario, y cada fila que se explica es el suyo, ligado a la misma acción, con el botón que dice qué
// diferencia, tal como se vio. Explicar se confirma en dos pasos, en su fila, con la nota, como «Resolver a mano» de PA-84. En el teléfono solo se consulta: las
// acciones se ocultan por debajo del ancho de tableta, sin JavaScript, como en PA-84.

const text = admin.periods.reconciliation;
const IDLE: ReconcileState = { kind: "idle" };
const BLOCK_ID = PANEL_ANCHORS.reconciliation;
const HEADING_ID = "periodo-conciliacion-titulo";

export interface ReconcileBlockProps {
  periodId: number;
  view: ReconciliationView;
}

export function ReconcileBlock({ periodId, view }: ReconcileBlockProps) {
  // Sin `bind`: el periodo viaja en cada formulario (ver `reconcileAction`).
  const [state, send, pending] = useActionState(reconcileAction, IDLE, `${periodPath(periodId)}#${BLOCK_ID}`);
  // Qué se pulsó, para decir qué está en camino: comparar tarda segundos, explicar no.
  const [pressed, setPressed] = useState<"compare" | "explain">("compare");

  const attempt = state.kind === "idle" ? 0 : state.attempt;
  let result: string | null = null;
  let tone: "success" | "warning" | "danger" = "warning";
  if (!pending && state.kind === "done") {
    result = RECONCILE_ANSWERS[state.answer];
    tone = answerTone(state.answer);
  } else if (!pending && state.kind === "failed" && !(state.reason === "needs_code" && view.canExplain)) {
    // Si la página ya leyó un código reciente (se dio después), pedirlo ya no es cierto.
    result = withNote(RECONCILE_FAILURES[state.reason], state.note);
    tone = reconcileToneOf(state.reason);
  }
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const asking = state.kind === "asking" ? state : null;
  const { last } = view;
  const offersSomething = view.compare !== null || (last.kind === "compared" && last.differences.some((row) => row.offer.kind === "explain"));

  return (
    <section ref={block} id={BLOCK_ID} aria-labelledby={HEADING_ID} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <h2 id={HEADING_ID} className="text-h2">
        {text.title}
      </h2>
      <p className="text-text-2">{text.intro}</p>

      {last.kind === "never" ? (
        <p>{text.never}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p>
            {last.when} {last.by}
          </p>
          <ul className="flex flex-col gap-1">
            <li>{last.own}</li>
            <li>{last.provider}</li>
          </ul>
          <InlineAlert tone={last.tone}>{last.verdict}</InlineAlert>
          {last.notes.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-body-s">
              {last.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view.readOnly && <p className="text-body-s text-text-2">{text.readOnly}</p>}
      {view.notYet && <p className="text-body-s text-text-2">{text.notYet}</p>}
      {offersSomething && <p className="text-body-s text-text-2 md:hidden">{text.phoneOnly}</p>}
      {!view.canExplain && !view.readOnly && !view.notYet && <p className="hidden text-body-s text-text-2 md:block">{text.changeLocked}</p>}

      <BlockResult message={result} tone={tone} pending={pending} pendingText={pressed === "compare" ? text.comparing : text.explaining} answer={answer} spoken={spoken} />

      {view.compare !== null && (
        // En el teléfono solo se consulta: el botón no se pinta por debajo del ancho de tableta.
        <form action={send} noValidate onSubmit={() => setPressed("compare")} className="hidden md:block">
          <input type="hidden" name="period" value={periodId} />
          <Button type="submit" variant="secondary" name="do" value={view.compare} loading={pending && pressed === "compare"} loadingLabel={text.comparing} disabled={pending}>
            {text.compare}
          </Button>
        </form>
      )}

      {last.kind === "compared" && (
        <div className="flex flex-col gap-3">
          <h3 className="text-h3">{text.differencesTitle}</h3>
          <DataTable
            caption={text.differencesCaption}
            captionHidden
            scroll
            columns={[
              { key: "side", header: text.columns.side },
              { key: "charge", header: text.columns.charge },
              { key: "own", header: text.columns.own, numeric: true },
              { key: "provider", header: text.columns.provider, numeric: true },
              { key: "action", header: text.columns.action },
            ]}
            rows={last.differences.map((row) => ({
              key: row.key,
              cells: {
                side: row.side,
                charge: <span className="text-body-s break-all">{row.charge}</span>,
                own: row.own,
                provider: row.provider,
                action: (
                  <RowAction
                    periodId={periodId}
                    row={row}
                    asking={asking !== null && row.offer.kind === "explain" && sameDifference(asking.asked, row.offer.asked) ? asking : null}
                    answer={answer}
                    action={send}
                    pending={pending}
                    onSubmit={() => setPressed("explain")}
                  />
                ),
              },
            }))}
            empty={text.differencesNone}
          />
        </div>
      )}
    </section>
  );
}

const sameDifference = (a: { side: string; charge: string; currency: string; cents: string }, b: { side: string; charge: string; currency: string; cents: string }) =>
  a.side === b.side && a.charge === b.charge && a.currency === b.currency && a.cents === b.cents;

/** El mensaje, y la nota que se había escrito en la confirmación que ya se cerró: así no se pierde. */
function withNote(message: string, note: string | undefined): string {
  return note === undefined || note.trim() === "" ? message : `${message} ${t(admin.alerts.written, { text: note.trim() })}`;
}

interface RowActionProps {
  periodId: number;
  row: DifferenceRow;
  asking: Extract<ReconcileState, { kind: "asking" }> | null;
  answer: RefObject<HTMLDivElement | null>;
  action: (form: FormData) => void;
  pending: boolean;
  onSubmit: () => void;
}

function RowAction({ periodId, row, asking, answer, action, pending, onSubmit }: RowActionProps) {
  const explained = row.explained === null ? null : <span className="text-body-s break-words">{row.explained}</span>;
  if (row.offer.kind === "blocks") return <span className="text-body-s text-text-2">{text.blocks}</span>;
  if (row.offer.kind === "none") return explained;
  const offer = row.offer;
  return (
    // En el teléfono solo se consulta: la acción no se pinta por debajo del ancho de tableta.
    <form action={action} noValidate onSubmit={onSubmit} className="hidden min-w-64 flex-col gap-3 md:flex">
      <input type="hidden" name="period" value={periodId} />
      {asking !== null ? (
        <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 outline-none">
          <p className="font-semibold">{text.explainTitle}</p>
          <p className="text-body-s text-text-2">{text.explainBody}</p>
          <Textarea
            key={`nota-${asking.attempt}`}
            id="conciliacion-nota"
            label={text.noteLabel}
            name="note"
            hint={t(text.noteHint, { max: String(NOTE_MAX) })}
            defaultValue={asking.note}
            maxLength={NOTE_MAX}
            error={asking.problem === null ? undefined : text.failures.missingNote}
          />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" name="do" value={offer.confirm} size="md" disabled={pending}>
              {text.confirmExplain}
            </Button>
            <Button type="submit" name="do" value={reconcileButton.cancel()} variant="secondary" size="md" disabled={pending}>
              {text.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" name="do" value={offer.ask} variant="secondary" size="md" disabled={pending}>
          {text.explain} <span className="sr-only">{t(text.ofCharge, { charge: row.charge })}</span>
        </Button>
      )}
    </form>
  );
}
