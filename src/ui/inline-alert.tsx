import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide";
import type { ReactNode } from "react";

import { ui } from "@/messages/es/ui";

import { cx, SPACE } from "./cx";
import { Icon } from "./icon";

// Aviso en línea (diseño, sección 5.5): un mensaje pegado a lo que explica, dentro de la
// pantalla. Un estado nunca va solo: lleva su color, su icono y su nombre.

const TONES = {
  neutral: { icon: Info, box: "border-border bg-surface-2 halo-surface-2", mark: "text-text-2" },
  success: { icon: CircleCheck, box: "border-success bg-success-bg", mark: "text-success" },
  warning: { icon: TriangleAlert, box: "border-warning bg-warning-bg", mark: "text-warning" },
  danger: { icon: CircleAlert, box: "border-danger bg-danger-bg", mark: "text-danger" },
} as const;

export interface InlineAlertProps {
  tone: keyof typeof TONES;
  children: ReactNode;
  /** Un botón para resolver lo que el aviso dice. */
  action?: ReactNode;
}

export function InlineAlert({ tone, children, action }: InlineAlertProps) {
  const { icon, box, mark } = TONES[tone];
  return (
    // Un error interrumpe a quien usa lector de pantalla; lo demás espera su turno.
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("flex items-start gap-3 rounded-md border p-4 text-body text-text", box)}
    >
      <Icon icon={icon} className={cx("mt-0.5", mark)} />
      <div className="flex flex-1 flex-col items-start gap-2">
        <div>
          <span className="sr-only">{ui.alert[tone]}</span>
          {SPACE}
          {children}
        </div>
        {action}
      </div>
    </div>
  );
}
