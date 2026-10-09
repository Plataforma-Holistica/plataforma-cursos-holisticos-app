import { type ReactNode, useId } from "react";

import { ui } from "@/messages/es/ui";

import { CheckboxRow } from "./checkbox";
import { describedBy, FieldError } from "./field";

// Casilla de consentimiento (diseño, sección 5.3): recoge un consentimiento que se guarda
// con versión, fecha y origen (RF-108).
//
// Reglas: nunca viene marcada, y por eso no existe forma de marcarla desde fuera. Una
// casilla, un consentimiento. El texto completo va junto a la casilla, sin letra chica. El
// enlace al documento abre en otra pestaña, para no borrar lo escrito.

interface CommonProps {
  name: string;
  /** El texto del consentimiento, completo. Puede llevar el enlace a su documento. */
  label: ReactNode;
  id?: string;
  /** Se intentó seguir sin aceptarlo. */
  invalid?: boolean;
}

interface Simple extends CommonProps {
  /** Una línea con su enlace. */
  variant?: "simple";
}

interface Explained extends CommonProps {
  /** Un bloque con título, qué se guarda y para qué, y la casilla al final. */
  variant: "explained";
  title: ReactNode;
  /** Dos o tres frases. */
  description: ReactNode;
}

export type ConsentCheckboxProps = Simple | Explained;

export function ConsentCheckbox(props: ConsentCheckboxProps) {
  const generated = useId();
  const fieldId = props.id ?? generated;
  const errorId = `${fieldId}-error`;
  const descriptionId = `${fieldId}-description`;
  const invalid = props.invalid ?? false;
  const explained = props.variant === "explained";

  const row = (
    <div className="flex flex-col gap-1">
      <CheckboxRow
        id={fieldId}
        name={props.name}
        label={props.label}
        required
        invalid={invalid}
        // Quien llega a la casilla con el tabulador oye qué acepta (RF-108), y después
        // el error si lo hay.
        describedById={describedBy(explained && descriptionId, invalid && errorId)}
      />
      {invalid && <FieldError id={errorId}>{ui.consent.required}</FieldError>}
    </div>
  );

  if (props.variant !== "explained") return row;

  return (
    <fieldset className="flex flex-col gap-3 rounded-md border border-border bg-surface-1 p-4 halo-surface-1">
      <legend className="float-left w-full text-h3">{props.title}</legend>
      <div id={descriptionId} className="clear-both flex flex-col gap-2 text-body text-text-2">
        {props.description}
      </div>
      {row}
    </fieldset>
  );
}
