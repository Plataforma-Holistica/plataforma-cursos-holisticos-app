"use client";

import { CODE_ERRORS, CodeField, type CodeProblem } from "@/app/(cuenta)/_lib/fields";
import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";

import type { CodeState } from "./fresh-code";

// El bloque «Tu código» de las secciones de administración que cambian algo con un código
// reciente (PA-86 y PA-67). La pantalla del segundo factor saca de ahí a quien ya lo dio: por
// eso se da en la misma sección. Solo se pinta cuando la página leyó que el código de quien
// mira ya no es reciente, nunca porque otro bloque lo haya contestado. El código nunca vuelve:
// el campo se arma vacío con cada intento.
//
// Cada sección le da sus `id` (el del bloque es el ancla a la que vuelve el navegador sin
// JavaScript, y no se repite en ninguna otra pantalla) y lo que dice su cuerpo.

const text = admin.code;

export interface CodeBlockProps {
  /** El ancla del bloque: un `id` que ninguna otra pantalla usa. */
  blockId: string;
  titleId: string;
  fieldId: string;
  /** Para qué hace falta el código en esta sección. */
  body: string;
  /** El código es correcto y aun así ningún cambio pasaría. */
  notAvailable: string;
  state: CodeState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function CodeBlock({ blockId, titleId, fieldId, body, notAvailable, state, action, pending }: CodeBlockProps) {
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const problem: CodeProblem | undefined =
    state.kind === "invalid" ? state.problem : state.kind === "failed" && state.reason === "wrong_code" ? "wrong" : undefined;
  const errors: FormError[] = problem ? [{ fieldId, message: CODE_ERRORS[problem] }] : [];
  const unavailable = state.kind === "failed" && state.reason === "unavailable";
  const notAvailableNow = state.kind === "failed" && state.reason === "not_available";

  return (
    <section id={blockId} aria-labelledby={titleId} className="flex flex-col gap-4 rounded-md border border-border p-4">
      <h2 id={titleId} className="text-h3">
        {text.title}
      </h2>
      <p className="text-text-2">{body}</p>
      <form action={action} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={errors} attempt={attempt} />
        {/* Cada hermano lleva su propia `key`: con la misma, React confunde el aviso de un
            intento con el campo del siguiente. */}
        {!pending && unavailable && (
          <InlineAlert key={`fallo-${attempt}`} tone="danger" live>
            {account.common.unavailable}
          </InlineAlert>
        )}
        {!pending && notAvailableNow && (
          <InlineAlert key={`sin-arreglo-${attempt}`} tone="danger" live>
            {notAvailable}
          </InlineAlert>
        )}
        <CodeField key={`campo-${attempt}`} id={fieldId} problem={problem} round={attempt} readOnly={pending} />
        <Button type="submit" loading={pending} loadingLabel={text.submitting}>
          {text.submit}
        </Button>
      </form>
    </section>
  );
}
