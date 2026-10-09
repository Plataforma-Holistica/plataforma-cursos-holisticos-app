import { CircleAlert } from "lucide";
import type { ReactNode } from "react";

import { ui } from "@/messages/es/ui";

import { cx, SPACE } from "./cx";
import { Icon } from "./icon";

// Las piezas que comparten los campos de un formulario (diseño, sección 5.3): la etiqueta,
// la ayuda y el error. No se usan sueltas: las arman `TextField`, `PasswordField` y las
// casillas.
//
// Reglas: una columna; la etiqueta arriba y siempre visible; lo opcional dice
// «(opcional)» y lo obligatorio no lleva asterisco; el error dice qué pasó y cómo se
// arregla, y se enlaza al campo.

/** El campo: 48 px sobre `surface-2`, con borde de control. Foco con borde y con anillo. */
export const INPUT_CLASSES =
  "h-control w-full rounded-md border border-border-control bg-surface-2 px-3 text-body text-text transition-colors duration-(--duration-fast) ease-standard focus-visible:border-focus aria-invalid:border-danger read-only:text-text-2";

export function FieldLabel({
  htmlFor,
  optional = false,
  children,
}: {
  htmlFor: string;
  optional?: boolean;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="text-body-s font-semibold text-text">
      {children}
      {optional && (
        <>
          {SPACE}
          <span className="font-regular text-text-3">{ui.field.optional}</span>
        </>
      )}
    </label>
  );
}

export function FieldHint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-caption text-text-3">
      {children}
    </p>
  );
}

/** El mensaje de error: con icono, porque el color nunca es la única señal. */
export function FieldError({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={cx("flex items-start gap-2 text-body-s text-danger", className)}>
      <Icon icon={CircleAlert} size={16} className="mt-0.5" />
      <span>{children}</span>
    </p>
  );
}

/** Los `id` de lo que describe a un campo, en el orden en que se lee. */
export function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const present = ids.filter(Boolean);
  return present.length > 0 ? present.join(" ") : undefined;
}
