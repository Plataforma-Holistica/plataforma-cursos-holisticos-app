import { cx } from "./cx";

// Barra de progreso (`ProgressBar`, diseño, sección 5.3): el avance de un curso. Es la barra
// nativa (`<progress>`), pintada con los tokens desde `theme.css` (`progress-bar`), sin estilos
// en línea. La barra sola nunca es el dato: el texto va a la vista al lado («4 de 12
// lecciones»), y es también su valor para quien la lee.

export interface ProgressBarProps {
  value: number;
  max: number;
  /** Qué mide, para quien no la ve: «Avance del curso». */
  label: string;
  /** El dato en palabras, a la vista y como su valor: «4 de 12 lecciones». */
  text: string;
  /** Fina, de 3 px, para las tarjetas; media, de 6 px, para la ficha y el temario. */
  size?: "thin" | "medium";
  className?: string;
}

export function ProgressBar({ value, max, label, text, size = "medium", className }: ProgressBarProps) {
  // Lo lleno no sale de la barra, y una barra sin lecciones está vacía.
  const top = max > 0 ? max : 1;
  const now = Math.min(Math.max(value, 0), max > 0 ? max : 0);
  return (
    <div className={cx("flex items-center gap-3", className)}>
      <progress
        value={now}
        max={top}
        aria-label={label}
        aria-valuenow={now}
        aria-valuemin={0}
        aria-valuemax={top}
        aria-valuetext={text}
        data-size={size}
        className={cx("progress-bar flex-1", size === "thin" ? "progress-bar-thin" : "progress-bar-medium")}
      />
      <span aria-hidden="true" className="shrink-0 text-caption text-text-2 tabular-nums">
        {text}
      </span>
    </div>
  );
}
