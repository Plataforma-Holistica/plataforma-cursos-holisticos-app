"use client";

import { useActionState, useEffect, useRef } from "react";

import { LegalBody } from "@/app/_lib/legal-body";
import { portal } from "@/messages/es/portal";
import type { LegalBlock } from "@/services/legal/texts";
import { BackLink } from "@/ui/back-link";
import { Button } from "@/ui/button";
import { ConsentCheckbox } from "@/ui/consent-checkbox";
import { InlineAlert } from "@/ui/inline-alert";
import { TextLink } from "@/ui/text-link";

import { PortalMain } from "../_lib/shell";
import { submitCourseAction } from "./actions";
import { t } from "@/messages/format";

import { ACCEPT_FIELD, type RemoveFailure, type SubmitFailure, type SubmitState } from "./outcomes";
import type { SubmitView } from "./rows";

// PA-44 · Enviar a revisión (`/portal/cursos/<id>/enviar`; RF-606, FL-34; T-405). Tres pasos que se ven a la vez: lo que falta o lo completo, los avisos que no impiden enviar, y el
// anexo con la casilla. Sin JavaScript funciona igual: es un formulario. Sin resumen del anexo hasta tener el del abogado (D-15): se muestra el texto completo y la frase que se
// acepta, que nombra el curso (decisión mía sin confirmar). También en el teléfono: un maestro puede enviar desde ahí un curso que ya dejó listo.

const text = portal.submit;
const IDLE: SubmitState = { kind: "idle" };
const BLOCK_ID = "bloque-enviar";

const FAILURES: Record<Exclude<SubmitFailure, "video_not_ready"> | RemoveFailure, string> = {
  remove_changed: text.failures.removeChanged,
  remove_unavailable: text.failures.removeUnavailable,
  remove_unknown: text.failures.removeUnknown,
  not_accepted: text.failures.notAccepted,
  changed: text.failures.changed,
  not_ready: text.failures.notReady,
  annex_missing: text.annexMissing,
  origin_missing: text.failures.originMissing,
  unavailable: text.failures.unavailable,
  unknown: text.failures.unknown,
};

export function SubmitScreen({ view, blocks }: { view: SubmitView; blocks: readonly LegalBlock[] }) {
  const [state, action, pending] = useActionState(submitCourseAction, IDLE, `${view.self}#${BLOCK_ID}`);
  const answer = useRef<HTMLDivElement>(null);
  const answered = !pending && state.kind !== "idle" ? state : null;
  const failed = answered?.kind === "failed" ? answered : null;
  const said =
    answered === null
      ? null
      : answered.kind === "removed"
        ? text.removed
        : answered.reason === "video_not_ready"
          ? t(text.failures.videoNotReady, { lessons: answered.lessons.map((lesson) => (lesson in view.lessonTitles ? `«${view.lessonTitles[lesson]}»` : text.failures.oneLesson)).join(", ") })
          : // Lo que la página ya dice por su cuenta, con la vista de ahora, no se repite.
            answered.reason === "annex_missing" && view.blocked !== null
            ? null
            : FAILURES[answered.reason];

  // La respuesta toma el foco: el botón que se pulsó pudo irse con la página nueva (al quitar, con su fila).
  useEffect(() => {
    if (answered !== null) answer.current?.focus();
  }, [answered]);

  return (
    <PortalMain title={view.title} titleId="enviar-titulo" above={<BackLink href={view.back}>{text.back}</BackLink>} lead={<p>{text.intro}</p>} measure="reading">
      <section id={BLOCK_ID} aria-labelledby="enviar-titulo" className="flex flex-col gap-8">
        {answered !== null && said !== null && (
          <div ref={answer} tabIndex={-1} className="outline-none">
            <InlineAlert tone={answered.kind === "removed" ? "success" : failed?.reason === "unknown" || failed?.reason === "unavailable" ? "danger" : "warning"}>{said}</InlineAlert>
          </div>
        )}
        {view.blocked !== null && <InlineAlert tone="warning">{view.blocked}</InlineAlert>}

        {view.blocked === null && (
        <form action={action} noValidate className="flex flex-col gap-8">
          <section aria-labelledby="enviar-paso-1" className="flex flex-col gap-3 surface-raised p-4 sm:p-5">
            <h2 id="enviar-paso-1" className="text-h3">
              {view.missing.length > 0 ? text.step1Missing : text.step1}
            </h2>
            {view.missing.length > 0 ? (
              <ul className="flex flex-col gap-3">
                {view.missing.map((line) => (
                  <li key={line.text + (line.href ?? line.remove ?? "")} className="flex flex-wrap items-center gap-3">
                    <span className="min-w-0 flex-auto break-words">{line.text}</span>
                    {line.href !== null && <TextLink href={line.href}>{text.goTo}</TextLink>}
                    {line.remove !== null && (
                      <Button type="submit" name="do" value={line.remove} variant="secondary" size="md" disabled={pending}>
                        {text.removePending}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="flex flex-col gap-1">
                {view.done.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="enviar-paso-2" className="flex flex-col gap-3 surface-raised p-4 sm:p-5">
            <h2 id="enviar-paso-2" className="text-h3">
              {text.step2}
            </h2>
            {view.warnings.length === 0 ? (
              <p className="text-text-2">{text.noWarnings}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {view.warnings.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </section>

          {view.annex !== null && (
            <section aria-labelledby="enviar-paso-3" className="flex flex-col gap-4 surface-raised p-4 sm:p-5">
              <h2 id="enviar-paso-3" className="text-h3">
                {text.step3}
              </h2>
              <p className="font-semibold">{view.annex.title}</p>
              <p className="text-body-s text-text-2">{view.annex.meta}</p>
              {view.annex.draft && <p className="text-body-s text-text-2">{text.draftAnnex}</p>}
              <div tabIndex={0} aria-label={text.annexBox} className="max-h-96 overflow-y-auto rounded-md border border-border p-4">
                <LegalBody title={view.annex.title} blocks={blocks} />
              </div>
              <p className="text-body-s">
                <TextLink href={view.annex.href} external>
                  {text.openAnnex}
                </TextLink>
              </p>
              <ConsentCheckbox name={ACCEPT_FIELD} label={view.annex.statement} invalid={failed?.reason === "not_accepted"} />
              <div className="flex flex-col gap-2">
                <div>
                  <Button type="submit" name="do" value={view.annex.button} loading={pending} loadingLabel={text.submitting}>
                    {text.submit}
                  </Button>
                </div>
                <p className="text-body-s text-text-2">{text.lockedNote}</p>
              </div>
            </section>
          )}
        </form>
        )}
      </section>
    </PortalMain>
  );
}
