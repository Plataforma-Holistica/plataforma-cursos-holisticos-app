"use client";

import { CODE_ERRORS, CodeField, type CodeProblem } from "@/app/(cuenta)/_lib/fields";
import { account } from "@/messages/es/account";
import { admin } from "@/messages/es/admin";
import { Button } from "@/ui/button";
import { type FormError, FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";

import type { CodeState } from "./outcomes";

// PA-86 · El bloque «Tu código». Cambiar el equipo pide un código reciente, y la pantalla
// del segundo factor saca de ahí a quien ya lo dio: por eso se da aquí mismo. Solo se pinta
// cuando la página leyó que el código de quien mira ya no es reciente, nunca porque otro
// bloque lo haya contestado. El código nunca vuelve: el campo se arma vacío con cada intento.

const text = admin.team;
// Un `id` que ninguna otra pantalla usa: si la acción redirige, el navegador sin JavaScript
// se lleva el ancla a la pantalla de destino, y allá no debe apuntar a nada.
export const CODE_BLOCK_ID = "bloque-equipo-codigo";
const TITLE_ID = "equipo-codigo-titulo";
const FIELD_ID = "equipo-codigo";

export interface CodeBlockProps {
  state: CodeState;
  action: (form: FormData) => void;
  pending: boolean;
}

export function CodeBlock({ state, action, pending }: CodeBlockProps) {
  const attempt = state.kind === "idle" ? 0 : state.attempt;
  const problem: CodeProblem | undefined =
    state.kind === "invalid" ? state.problem : state.kind === "failed" && state.reason === "wrong_code" ? "wrong" : undefined;
  const errors: FormError[] = problem ? [{ fieldId: FIELD_ID, message: CODE_ERRORS[problem] }] : [];
  const unavailable = state.kind === "failed" && state.reason === "unavailable";
  const notAvailable = state.kind === "failed" && state.reason === "not_available";

  return (
    <section id={CODE_BLOCK_ID} aria-labelledby={TITLE_ID} className="flex flex-col gap-4 rounded-md border border-border p-4">
      <h2 id={TITLE_ID} className="text-h3">
        {text.codeTitle}
      </h2>
      <p className="text-text-2">{text.codeBody}</p>
      <form action={action} noValidate className="flex flex-col gap-6">
        <FormErrorSummary errors={errors} attempt={attempt} />
        {/* Cada hermano lleva su propia `key`: con la misma, React confunde el aviso de un
            intento con el campo del siguiente. */}
        {!pending && unavailable && (
          <InlineAlert key={`fallo-${attempt}`} tone="danger" live>
            {account.common.unavailable}
          </InlineAlert>
        )}
        {!pending && notAvailable && (
          <InlineAlert key={`sin-arreglo-${attempt}`} tone="danger" live>
            {text.codeNotAvailable}
          </InlineAlert>
        )}
        <CodeField key={`campo-${attempt}`} id={FIELD_ID} problem={problem} round={attempt} readOnly={pending} />
        <Button type="submit" loading={pending} loadingLabel={text.codeSubmitting}>
          {text.codeSubmit}
        </Button>
      </form>
    </section>
  );
}
