"use client";

import type { RefObject } from "react";

import { admin } from "@/messages/es/admin";
import { Button } from "@/ui/button";
import { SPACE } from "@/ui/cx";

import type { Confirmation, RowButton } from "./rows";

export { BlockResult, useAnswerFocus } from "../_lib/answer";

// Lo que comparten los bloques de la pantalla del equipo (diseño, PA-86) que son una lista
// con botones: el botón de una fila y la confirmación en dos pasos. El foco al contestar y el
// resultado son los de `_lib/answer.tsx`, compartidos con PA-67.

const text = admin.team;

/** El botón de una fila. Dice qué hace y, para quien no ve la fila, a quién. */
export function RowAction({ button, pending, variant = "secondary" }: { button: RowButton; pending: boolean; variant?: "secondary" | "text" }) {
  return (
    <Button type="submit" name="do" value={button.value} variant={variant} size="md" disabled={pending}>
      {button.label}
      {/* Sin el espacio, el nombre del botón se leería pegado. */}
      {SPACE}
      <span className="sr-only">{button.detail}</span>
    </Button>
  );
}

export interface ConfirmPanelProps {
  confirmation: Confirmation;
  /** La lista cambió mientras se confirmaba: lo que sigue es lo que pasaría ahora. */
  changed?: boolean;
  pending: boolean;
  pendingLabel: string;
  box: RefObject<HTMLDivElement | null>;
}

/**
 * El segundo paso de lo que no se deshace solo: dice todo lo que va a pasar, y ofrece
 * hacerlo o cancelar. Va dentro del formulario de su bloque: sus dos botones dicen lo suyo
 * con su valor, y funciona sin JavaScript.
 */
export function ConfirmPanel({ confirmation, changed = false, pending, pendingLabel, box }: ConfirmPanelProps) {
  return (
    <div ref={box} tabIndex={-1} className="flex flex-col gap-3 rounded-md border border-warning bg-warning-bg p-4 outline-none">
      {changed && <p className="text-body-s">{text.listChanged}</p>}
      <p className="text-body font-semibold">{confirmation.title}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-body-s">
        {confirmation.effects.map((effect) => (
          <li key={effect}>{effect}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="do" value={confirmation.value} variant="danger" size="md" loading={pending} loadingLabel={pendingLabel}>
          {confirmation.button}
        </Button>
        <Button type="submit" name="do" value="cancel" variant="secondary" size="md" disabled={pending}>
          {text.cancel}
        </Button>
      </div>
    </div>
  );
}
