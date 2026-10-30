"use client";

import { useActionState } from "react";

import { portal } from "@/messages/es/portal";
import { portalNewCoursePath, ROUTES } from "@/services/account/navigation";
import { DRAFT_TEXT_LIMITS } from "@/services/drafts/field-rules";
import { Button } from "@/ui/button";
import { FormErrorSummary } from "@/ui/form-error-summary";
import { InlineAlert } from "@/ui/inline-alert";

import { CountedField } from "../_lib/counted-field";
import { failureText, problemText } from "../_lib/words";
import { createCourseAction } from "./actions";
import type { NewCourseState } from "./outcomes";

// Crear un curso (T-402; FL-32, paso 1): el título y nada más. El testigo lo pone la página al
// pintarse; si la respuesta trae uno, manda ese, para que reintentar no cree otro curso.

const text = portal.newCourse;
const IDLE: NewCourseState = { kind: "idle" };
const BLOCK_ID = "bloque-curso-nuevo";
const FIELD_ID = "curso-nuevo-titulo";
// El título avisa al pasar de 48 caracteres (03 §4.1).
const WARN_AT = 48;

export function NewCourseScreen({ token }: { token: string }) {
  const [state, action, pending] = useActionState(createCourseAction, IDLE, `${portalNewCoursePath()}#${BLOCK_ID}`);
  const title = state.kind === "idle" ? "" : state.title;
  const error = state.kind === "invalid" ? problemText("courseTitle", state.problem) : null;

  return (
    <section id={BLOCK_ID} aria-labelledby="curso-nuevo-encabezado" className="flex max-w-form flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 id="curso-nuevo-encabezado" className="text-h1">
          {text.title}
        </h1>
        <p className="text-text-2">{text.intro}</p>
      </div>
      <form action={action} className="flex flex-col gap-6">
        <FormErrorSummary errors={error ? [{ fieldId: FIELD_ID, message: error }] : []} attempt={state.kind === "idle" ? 0 : state.attempt} />
        {state.kind === "failed" && (
          <InlineAlert tone="danger" live>
            {failureText(state.reason)}
          </InlineAlert>
        )}
        <input type="hidden" name="token" value={state.kind === "idle" ? token : state.token} />
        <CountedField
          key={state.kind === "idle" ? "inicio" : `intento-${state.attempt}`}
          id={FIELD_ID}
          name="title"
          label={text.titleLabel}
          max={DRAFT_TEXT_LIMITS.courseTitle}
          warnAt={WARN_AT}
          defaultValue={title}
          error={error}
          readOnly={pending}
        />
        <div className="flex flex-wrap gap-3">
          <Button href={ROUTES.portalCourses} variant="secondary">
            {text.cancel}
          </Button>
          <Button type="submit" loading={pending} loadingLabel={text.creating}>
            {text.create}
          </Button>
        </div>
      </form>
    </section>
  );
}
