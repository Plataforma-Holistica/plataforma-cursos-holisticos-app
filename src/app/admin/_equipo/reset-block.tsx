"use client";

import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { t } from "@/messages/format";
import { ROUTES } from "@/services/account/navigation";

import { resetButton, type ResetFailure, type ResetState } from "./outcomes";
import { BlockResult, ConfirmPanel, RowAction, useAnswerFocus } from "./parts";
import type { ResetOption } from "./rows";

// PA-86 · El bloque «Restablecer un segundo factor». Es un bloque aparte, con su formulario,
// su acción y su estado, y eso no es un detalle: la respuesta de restablecer trae el código
// que hay que dictar, y sin JavaScript React manda el estado de una acción dentro de todo
// formulario ligado a ella. Si restablecer fuera un botón de cada fila del equipo, el código
// viajaría en cada «Dar» y cada «Quitar».
//
// Por eso, mientras ese estado trae el código, aquí no se pinta ningún formulario: solo el
// código y un enlace que vuelve a pedir la página, que es lo que suelta ese estado. El código
// no va en un campo oculto, y deja de pintarse al salir de la página y con el siguiente envío
// de cualquier bloque.
//
// Un límite, medido en Next 16.3: cuando el formulario se envía sin que React lo tenga
// tomado (sin JavaScript, o antes de terminar de cargar), el documento de respuesta trae el
// estado de la acción una segunda vez, dentro de los datos con que React se monta. Es el
// mismo documento que ya pinta el código, no viaja de vuelta al servidor y no está en
// ningún campo; pero esa copia no la quita «dejar de pintar». Se va con el enlace de abajo,
// que carga la página entera: por eso el bloque no ofrece otra salida.

const text = admin.team;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
export const RESET_BLOCK_ID = "bloque-equipo-restablecer";
const TITLE_ID = "equipo-restablecer-titulo";

const FAILURES: Record<ResetFailure, string> = {
  already_sent: text.resetAlreadySent,
  self: text.resetSelf,
  ineligible: text.resetIneligible,
  not_member: text.resetNotMember,
  not_configured: text.notConfigured,
  invalid: text.invalid,
  needs_code: text.needsCode,
  unavailable: account.common.unavailable,
  unknown: text.resetUnknown,
};

/**
 * Vuelve a pedir la página. Va como `<a>` a propósito: tiene que ser una carga completa, que
 * es la que suelta el estado que trae el código. Una navegación de cliente lo conservaría.
 */
function ReloadLink({ label }: { label: string }) {
  return (
    <a href={ROUTES.team} className="text-body-s text-accent underline underline-offset-4 hover:text-accent-strong">
      {label}
    </a>
  );
}

export interface ResetBlockProps {
  /** A quién se le puede restablecer, como lo leyó la página. */
  options: readonly ResetOption[];
  /** El código de quien mira es reciente: se ofrecen los cambios. */
  canChange: boolean;
  state: ResetState;
  /** El código de esa respuesta ya no se pinta: se salió de la página, o se envió otra cosa. */
  codeHidden: boolean;
  action: (form: FormData) => void;
  pending: boolean;
}

export function ResetBlock({ options, canChange, state, codeHidden, action, pending }: ResetBlockProps) {
  const attempt = "attempt" in state ? state.attempt : 0;
  const result = pending || state.kind !== "failed" ? null : FAILURES[state.reason];
  const { block, answer, spoken } = useAnswerFocus(pending, attempt, result);
  const asked = canChange && state.kind === "confirm" ? state : null;
  const chosen = asked === null ? null : (options.find((option) => option.id === asked.profile) ?? null);
  // La persona que se iba a restablecer ya no se puede: salió del equipo o su cuenta cambió.
  const lost = asked !== null && chosen === null;

  if (state.kind === "code") {
    return (
      <section ref={block} id={RESET_BLOCK_ID} aria-labelledby={TITLE_ID} tabIndex={-1} className="flex flex-col gap-4 outline-none">
        <h2 id={TITLE_ID} className="text-h3">
          {text.resetTitle}
        </h2>
        {codeHidden ? (
          <p className="text-body-s text-text-2">{text.codeHidden}</p>
        ) : (
          <div ref={answer} tabIndex={-1} className="flex flex-col gap-3 rounded-md border border-success bg-success-bg p-4 outline-none">
            <p className="text-body font-semibold">{text.codeShownTitle}</p>
            <p>
              <code className="text-body-l font-semibold break-all">{state.code}</code>
            </p>
            <p className="text-body-s">{text.codeShownBody}</p>
            <p className="text-body-s">{t(text.codeShownNext, { path: ROUTES.recover })}</p>
            <p className="text-body-s">{text.codeShownReload}</p>
          </div>
        )}
        <p>
          <ReloadLink label={codeHidden ? text.backToList : text.codeDone} />
        </p>
        {/* La región viva existe igual que en las otras formas del bloque. */}
        <span ref={spoken} role="status" className="sr-only" />
      </section>
    );
  }

  return (
    <section ref={block} id={RESET_BLOCK_ID} aria-labelledby={TITLE_ID} tabIndex={-1} className="flex flex-col gap-4 outline-none">
      <h2 id={TITLE_ID} className="text-h3">
        {text.resetTitle}
      </h2>
      <p className="text-body-s text-text-2">{text.resetIntro}</p>
      <BlockResult
        message={lost ? text.listChanged : result}
        tone={lost || (state.kind === "failed" && state.reason === "needs_code") ? "warning" : "danger"}
        pending={pending}
        pendingText={text.resetting}
        answer={answer}
        spoken={spoken}
      />
      {options.length === 0 ? (
        <p className="text-body-s text-text-2">{text.resetNobody}</p>
      ) : !canChange ? (
        <p className="text-body-s text-text-2">{text.changesLocked}</p>
      ) : (
        <form action={action} className="flex flex-col gap-4">
          {chosen !== null && asked !== null ? (
            // El botón lleva además la marca de esta confirmación: la de otra no vale.
            <ConfirmPanel
              confirmation={{ ...chosen.confirmation, value: resetButton.marked(chosen.confirmation.value, asked.token) }}
              changed={asked.changed}
              pending={pending}
              pendingLabel={text.resetting}
              box={answer}
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {options.map((option) => (
                <li
                  key={option.id}
                  className="flex flex-col gap-3 rounded-md border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <p className="text-body font-semibold break-all">{option.email}</p>
                  <RowAction button={option.choose} pending={pending} />
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
    </section>
  );
}
