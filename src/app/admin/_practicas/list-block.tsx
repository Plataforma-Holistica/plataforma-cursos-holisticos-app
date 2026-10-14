"use client";

import { useEffect, useRef, useState } from "react";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { CATALOG_NAME_MAX_LENGTH } from "@/services/catalog/field-rules";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";
import { TextField } from "@/ui/text-field";

import { BlockResult, useAnswerFocus } from "../_lib/answer";
import { catalogButton, type CatalogFailure, type CatalogState, type NameProblem } from "./outcomes";
import type { CatalogRow, ListView } from "./rows";

// PA-67 · Una de las dos listas, prácticas o niveles. Arriba, agregar; abajo, la lista en su
// orden, con las desactivadas en su lugar y marcadas. Dos formularios ligados a la misma
// acción y al mismo estado (decisiones de Sergio del 2026-10-14: desactivar sin confirmar,
// ordenar con «Subir» y «Bajar», las desactivadas en su lugar).
//
// La lista es un solo formulario, y cada botón dice lo suyo con su valor: así funciona sin
// JavaScript. Mientras una fila está abierta para renombrar, el formulario no pinta ningún
// otro botón que «Guardar» y «Cancelar» de esa fila: con Enter en el campo, el navegador
// envía el formulario con su primer botón, y ese tiene que ser «Guardar».
//
// A dónde va el foco cuando llega la respuesta: un error de un campo, al resumen de errores
// de su formulario; lo agregado, al campo de agregar, ya vacío, para seguir agregando; lo
// movido, al mismo botón de la fila que se movió (o al del otro sentido, si ese ya no está),
// para seguir moviendo con el teclado; renombrar, a su campo; lo demás, al resultado
// (`useAnswerFocus`). Lo agregado y lo movido se dicen además por una región viva.

const text = admin.catalog;

// El tono de cada práctica, con clases escritas enteras: Tailwind no ve una armada con texto.
const TONE_CLASSES: Record<number, string> = {
  1: "bg-cover-1",
  2: "bg-cover-2",
  3: "bg-cover-3",
  4: "bg-cover-4",
  5: "bg-cover-5",
  6: "bg-cover-6",
  7: "bg-cover-7",
  8: "bg-cover-8",
};

const FAILURES: Record<CatalogFailure, string> = {
  list_changed: text.listChanged,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.unknown,
};

export interface ListBlockIds {
  /** El ancla del bloque: un `id` que ninguna otra pantalla usa. */
  block: string;
  heading: string;
  addField: string;
  renameField: string;
}

export interface ListBlockProps {
  list: "practices" | "levels";
  ids: ListBlockIds;
  view: ListView;
  /** El código de quien mira es reciente: se ofrecen los cambios. */
  canChange: boolean;
  state: CatalogState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function ListBlock({ list, ids, view, canChange, state, action, pending }: ListBlockProps) {
  const words = text[list];
  const attempt = "attempt" in state ? state.attempt : 0;
  const listForm = useRef<HTMLFormElement>(null);
  // La región viva de lo agregado y lo movido, que no pasa por el resultado.
  const quietVoice = useRef<HTMLSpanElement>(null);

  const nameError = (problem: NameProblem) =>
    problem === "required"
      ? text.nameRequired
      : problem === "too_long"
        ? t(text.nameTooLong, { max: String(CATALOG_NAME_MAX_LENGTH) })
        : problem === "duplicate"
          ? words.duplicate
          : text.nameInvalid;

  // La fila abierta para renombrar: solo si se pueden hacer cambios y si sigue en la lista,
  // activa. Lo decide el dato de la página, no lo que contestó el envío.
  const renaming =
    canChange && state.kind === "renaming" && view.rows.some((row) => row.id === state.id && row.active) ? state : null;
  const offered = canChange && renaming === null;

  // Lo que se pinta en el campo de agregar: lo escrito vuelve, salvo cuando ya se agregó.
  const typed =
    state.kind === "add_invalid" || state.kind === "inactive_duplicate" || (state.kind === "failed" && state.name !== null)
      ? (state.name ?? "")
      : "";
  // El campo de agregar se arma de nuevo solo con una respuesta de agregar. Con la de otro
  // botón del bloque («Subir», «Renombrar»…), lo que se estaba escribiendo sin enviar se
  // queda: el número de intento es del bloque entero, y como llave lo borraría.
  const addAnswer = typed !== "" || (state.kind === "done" && state.what === "added") || state.kind === "add_invalid";
  const [addRound, setAddRound] = useState(0);
  const [seenAttempt, setSeenAttempt] = useState(0);
  if (attempt !== seenAttempt) {
    setSeenAttempt(attempt);
    if (addAnswer) setAddRound(attempt);
  }

  const moved = state.kind === "done" && state.what === "moved" ? view.rows.find((row) => row.id === state.id) : undefined;
  // Lo agregado y lo movido no toman el foco con su aviso: se dicen aparte.
  const quiet: string | null = pending
    ? null
    : state.kind === "done" && state.what === "added"
      ? t(words.added, { name: state.name ?? "" })
      : moved?.place != null
        ? t(text.moved, { name: moved.name, place: String(moved.place), count: String(view.activeCount) })
        : null;
  const result: string | null = pending
    ? null
    : state.kind === "done" && state.what !== "added" && state.what !== "moved"
      ? state.what === "renamed"
        ? text.renamed
        : words[state.what]
      : state.kind === "unchanged"
        ? text.unchanged
        : state.kind === "failed"
          ? // Si la página ya leyó un código reciente (se dio después), pedirlo ya no es cierto.
            state.reason === "needs_code" && canChange
            ? null
            : FAILURES[state.reason]
          : state.kind === "inactive_duplicate" && canChange
            ? t(words.inactiveDuplicate, { name: state.name })
            : null;
  const tone = state.kind === "failed" && (state.reason === "unavailable" || state.reason === "unknown") ? "danger" : state.kind === "done" ? "success" : "warning";

  const { block, answer, spoken, away } = useAnswerFocus(pending, attempt, result);
  const { addField, renameField } = ids;

  // El foco y la voz de lo que no pasa por el resultado. Una vez por respuesta: si la lista
  // cambia después por otro lado (otro bloque la volvió a pedir), no se le quita el foco a
  // nadie.
  const handled = useRef(0);
  useEffect(() => {
    if (pending || attempt === 0 || handled.current === attempt) return;
    handled.current = attempt;
    let target: Element | null = null;
    if (state.kind === "done" && state.what === "added") target = document.getElementById(addField);
    else if (state.kind === "done" && state.what === "moved" && state.id !== null && state.direction !== null) {
      const other = state.direction === "up" ? "down" : "up";
      const form = listForm.current;
      target = form?.querySelector(`button[value^="${state.direction}:${state.id}:"]`) ?? form?.querySelector(`button[value^="${other}:${state.id}:"]`) ?? null;
    } else if (state.kind === "renaming" && state.problem === null) target = document.getElementById(renameField);
    else return;
    if (!away.current && target instanceof HTMLElement) target.focus();
    const voice = quietVoice.current;
    if (quiet === null || voice === null) return;
    voice.textContent = quiet;
    return () => {
      voice.textContent = "";
    };
  }, [attempt, pending, state, quiet, addField, renameField, away]);

  const addErrors: FormError[] = state.kind === "add_invalid" ? [{ fieldId: ids.addField, message: nameError(state.problem) }] : [];
  const renameErrors: FormError[] = renaming?.problem ? [{ fieldId: ids.renameField, message: nameError(renaming.problem) }] : [];

  return (
    <section ref={block} id={ids.block} aria-labelledby={ids.heading} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <h2 id={ids.heading} className="text-h3">
        {words.title}
      </h2>
      {!canChange && <p className="text-body-s text-text-2">{text.changesLocked}</p>}

      {canChange && (
        <form action={action} noValidate className="flex flex-col gap-4">
          <FormErrorSummary errors={addErrors} attempt={attempt} />
          {/* Con cada respuesta de agregar el campo se arma de nuevo, con lo que quedó. */}
          <TextField
            key={`agregar-${addRound}`}
            id={ids.addField}
            label={words.addLabel}
            name="name"
            autoComplete="off"
            defaultValue={typed}
            readOnly={pending}
            error={state.kind === "add_invalid" ? nameError(state.problem) : undefined}
          />
          <div>
            {/* Inactivo, y no «cargando», mientras va un envío: puede ser de otro botón del bloque. */}
            <Button type="submit" name="do" value={catalogButton.add()} variant="secondary" size="md" disabled={pending}>
              {words.addSubmit}
            </Button>
          </div>
        </form>
      )}

      {quiet !== null && (
        <InlineAlert key={`hecho-${attempt}`} tone="success">
          {quiet}
        </InlineAlert>
      )}
      {/* Existe desde antes de cargar: una región que nace con su texto no siempre se anuncia. */}
      <span ref={quietVoice} role="status" className="sr-only" />

      <form ref={listForm} action={action} noValidate className="flex flex-col gap-4">
        <FormErrorSummary errors={renameErrors} attempt={attempt} />
        <BlockResult message={result} tone={tone} pending={pending} pendingText={text.working} answer={answer} spoken={spoken} />
        {offered && state.kind === "inactive_duplicate" && (
          <div>
            <Button type="submit" name="do" value={catalogButton.reactivate(state.id)} variant="secondary" size="md" disabled={pending}>
              {text.reactivate}
              {SPACE}
              <span className="sr-only">{t(text.of, { name: state.name })}</span>
            </Button>
          </div>
        )}
        {view.rows.length === 0 ? (
          <p className="text-body-s text-text-2">{words.empty}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {view.rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                inactiveLabel={words.inactive}
                offered={offered}
                renaming={renaming?.id === row.id ? renaming : null}
                renameFieldId={ids.renameField}
                renameError={renaming?.id === row.id && renaming.problem !== null ? nameError(renaming.problem) : undefined}
                attempt={attempt}
                pending={pending}
              />
            ))}
          </ol>
        )}
      </form>
    </section>
  );
}

interface RowProps {
  row: CatalogRow;
  inactiveLabel: string;
  /** Se ofrecen sus botones: se pueden hacer cambios y ninguna fila está abierta. */
  offered: boolean;
  renaming: Extract<CatalogState, { kind: "renaming" }> | null;
  renameFieldId: string;
  renameError: string | undefined;
  attempt: number;
  pending: boolean;
}

function Row({ row, inactiveLabel, offered, renaming, renameFieldId, renameError, attempt, pending }: RowProps) {
  const toneClass = row.tone === null ? undefined : TONE_CLASSES[row.tone.number];
  const buttons: [string | null, string][] = [
    [row.buttons.up, text.up],
    [row.buttons.down, text.down],
    [row.buttons.rename, text.rename],
    [row.buttons.deactivate, text.deactivate],
    [row.buttons.reactivate, text.reactivate],
  ];

  return (
    <li className={`flex flex-col gap-3 rounded-md border border-border p-4 ${row.active ? "" : "opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-3">
        {toneClass !== undefined && <span aria-hidden="true" className={`size-5 shrink-0 rounded-sm ${toneClass}`} />}
        <p className="min-w-0 text-body font-semibold break-words">{row.name}</p>
        {!row.active && <span className="text-body-s text-text-2">{inactiveLabel}</span>}
      </div>
      {row.tone !== null && <p className="text-body-s text-text-2">{t(text.toneOf, { tone: row.tone.name })}</p>}
      {renaming !== null && (
        <div className="flex flex-col gap-3">
          <TextField
            key={`renombrar-${attempt}`}
            id={renameFieldId}
            label={t(text.renameLabel, { name: row.name })}
            name="name"
            autoComplete="off"
            hint={text.renameHint}
            defaultValue={renaming.name ?? row.name}
            readOnly={pending}
            error={renameError}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" name="do" value={catalogButton.save(row.id)} size="md" loading={pending} loadingLabel={text.working}>
              {text.save}
            </Button>
            <Button type="submit" name="do" value={catalogButton.cancel()} variant="secondary" size="md" disabled={pending}>
              {text.cancel}
            </Button>
          </div>
        </div>
      )}
      {offered && (
        <div className="flex flex-wrap gap-2">
          {buttons.map(
            ([value, label]) =>
              value !== null && (
                <Button key={value} type="submit" name="do" value={value} variant="secondary" size="md" disabled={pending}>
                  {label}
                  {/* Sin el espacio, el nombre del botón se leería pegado. */}
                  {SPACE}
                  <span className="sr-only">{row.detail}</span>
                </Button>
              ),
          )}
        </div>
      )}
    </li>
  );
}
