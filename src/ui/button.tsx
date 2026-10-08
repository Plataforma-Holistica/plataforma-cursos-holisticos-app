import Link from "next/link";
import { type MouseEventHandler, type ReactNode, useId } from "react";

import { cx } from "./cx";
import { Spinner } from "./spinner";

// Botón (diseño, sección 5.3). Un `<button>` de verdad, o un enlace si navega.
//
// Hay un solo botón principal por pantalla. Su texto dice la acción completa («Cancelar
// suscripción», no «Aceptar»), y sale del catálogo: lo pasa la pantalla.

const VARIANTS = {
  /** La acción de la pantalla. En teléfono ocupa todo el ancho. */
  primary: "w-full bg-text text-bg hover:bg-text-2 active:bg-text-2 sm:w-auto",
  secondary: "border border-border-control text-text hover:bg-surface-2 active:bg-surface-1",
  text: "text-accent underline-offset-4 hover:text-accent-strong hover:underline",
  /** Lo que no se deshace. Sin relleno. */
  danger: "border border-danger text-danger hover:bg-danger-bg active:bg-danger-bg",
} as const;

const SIZES = {
  /** 48 px: el alumno y las acciones principales. */
  lg: "h-control px-6",
  /** 40 px: administración. */
  md: "h-control-sm px-4",
} as const;

const BASE =
  "inline-grid cursor-pointer place-items-center rounded-md text-body font-semibold transition-colors duration-(--duration-fast) ease-standard";

// Un control inactivo: texto apagado y sin borde de control.
const DISABLED =
  "disabled:cursor-not-allowed disabled:border-transparent disabled:bg-surface-2 disabled:text-text-disabled disabled:no-underline";

// Cargando no es inactivo: el botón no acepta otro clic, pero su texto dice qué está
// pasando y tiene que leerse. Mismo fondo, texto con contraste completo.
const LOADING =
  "disabled:cursor-progress disabled:border-transparent disabled:bg-surface-2 disabled:text-text-2 disabled:no-underline";

// El texto de reposo y el de carga ocupan la misma celda: el botón mide lo que el más
// ancho, y así no cambia de tamaño al cargar.
const LAYER = "col-start-1 row-start-1 inline-flex items-center gap-2";

interface CommonProps {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  children: ReactNode;
  className?: string;
}

interface AsButton extends CommonProps {
  href?: undefined;
  type?: "button" | "submit";
  name?: string;
  value?: string;
  form?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Está trabajando: no acepta un segundo clic. Pide `loadingLabel`. */
  loading?: boolean;
  /** El texto en gerundio mientras carga: «Guardando…». */
  loadingLabel?: string;
  disabled?: boolean;
  /** Por qué está inactivo. Un control deshabilitado siempre tiene al lado su razón. */
  disabledReason?: string;
}

interface AsLink extends CommonProps {
  href: string;
}

export type ButtonProps = AsButton | AsLink;

export function Button(props: ButtonProps) {
  const reasonId = useId();
  const { variant = "primary", size = "lg", children, className } = props;
  const classes = cx(BASE, VARIANTS[variant], SIZES[size], className);

  if (props.href !== undefined) {
    return (
      <Link href={props.href} className={classes}>
        <span className={LAYER}>{children}</span>
      </Link>
    );
  }

  const { type = "button", loading = false, loadingLabel, disabled = false, disabledReason } = props;

  const button = (
    <button
      type={type}
      name={props.name}
      value={props.value}
      form={props.form}
      onClick={props.onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      className={cx(classes, loading ? LOADING : DISABLED)}
    >
      <span className={cx(LAYER, loading && "invisible")} aria-hidden={loading || undefined}>
        {children}
      </span>
      {loadingLabel !== undefined && (
        <span className={cx(LAYER, !loading && "invisible")} aria-hidden={loading ? undefined : true}>
          <Spinner size={16} decorative />
          {loadingLabel}
        </span>
      )}
    </button>
  );

  // `aria-busy` no se lee en voz alta, y un botón que se deshabilita se queda mudo. Esta
  // región, que existe desde antes de cargar, es la que le dice a quien no lo ve que su
  // clic sirvió.
  const status = loadingLabel !== undefined && (
    <span role="status" className="sr-only">
      {loading ? loadingLabel : null}
    </span>
  );

  if (!disabledReason) {
    return (
      <>
        {button}
        {status}
      </>
    );
  }

  return (
    <span className={cx("inline-flex flex-col gap-2", variant === "primary" && "w-full sm:w-auto")}>
      {button}
      {status}
      <span id={reasonId} className="text-caption text-text-3">
        {disabledReason}
      </span>
    </span>
  );
}
