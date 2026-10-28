import { TriangleAlert } from "lucide";
import type { ReactNode } from "react";

import { ui } from "@/messages/es/ui";

import { cx } from "./cx";
import { Icon } from "./icon";

// Cifra (diseño, sección 5): un número con su nombre. Etiqueta en `label`, cifra en `stat` con cifras
// tabulares, y una línea de contexto en `caption`. Sin dato no se pinta un cero: se dice que no hay
// datos. Una cifra que todavía puede cambiar (parcial, estimada) lleva su etiqueta delante, en tono de
// atención y con borde punteado: nunca se ve igual que la final.

export interface StatTileProps {
  label: string;
  /** La cifra ya escrita; nula si no se midió. */
  value: string | null;
  /** Una línea de contexto debajo de la cifra. */
  context?: ReactNode;
  /** La etiqueta de una cifra que puede cambiar («Parcial, al {fecha}»). Se lee antes que la cifra. */
  tag?: string;
  /** La cifra pide atención (pasó un umbral): va en tono de atención y con icono. */
  tone?: "attention";
}

export function StatTile({ label, value, context, tag, tone }: StatTileProps) {
  const attention = tone === "attention";
  return (
    <div className={cx("flex flex-col gap-1 rounded-md border p-4", tag === undefined ? "border-border" : "border-dashed border-warning")}>
      <p className="text-label text-text-2 uppercase">{label}</p>
      {tag !== undefined && <p className="text-caption text-warning">{tag}</p>}
      {value === null ? (
        <p className="text-body text-text-2">{ui.stat.noData}</p>
      ) : (
        <p className="flex items-center gap-2">
          {attention && <Icon icon={TriangleAlert} className="text-warning" />}
          <span className={cx("text-stat tabular-nums", attention ? "text-warning" : "text-text")}>{value}</span>
        </p>
      )}
      {context !== undefined && <p className="text-caption text-text-2">{context}</p>}
    </div>
  );
}
