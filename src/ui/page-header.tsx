import Image, { type StaticImageData } from "next/image";
import type { ReactNode } from "react";

import { cx } from "./cx";
import { Filigree } from "./flower";

// La cabecera de una pantalla (T-616): el antetítulo en versalitas, el título grande y angosto, y una
// línea que lo acompaña. Detrás, un resplandor índigo muy tenue y, según el lugar, una foto de ambiente
// (las del alumno: inicio, explorar, mi lista, planes) o la filigrana de la flor de la vida (el portal, la
// administración, la cuenta), que da textura sin foto.
//
// Dos tamaños. `regular`, con la foto velada de arriba abajo. `hero` (el inicio, segunda vuelta): alta,
// la foto se ve, el velo sube solo desde abajo, el texto se apoya abajo y la filigrana va a la derecha.
//
// El antetítulo de una cabecera va siempre en oro pleno: en oro apagado no llegaba a 4.5 ni sobre la foto (4.2)
// ni sobre la filigrana con su resplandor (4.38). El oro apagado se queda para los antetítulos sobre el fondo liso.
// Cada foto se mide con su texto (contraste AA). La foto carga primero: es lo más grande que se ve al llegar.
// El título es el `<h1>` de la pantalla.

export interface PageHeaderProps {
  title: ReactNode;
  eyebrow?: string;
  /** Lo que acompaña al título, en el segundo tono. */
  lead?: ReactNode;
  photo?: StaticImageData;
  size?: "regular" | "hero";
  /** Lo que va debajo, dentro de la cabecera (un buscador, una línea más). */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, eyebrow, lead, photo, size = "regular", children, className }: PageHeaderProps) {
  const hero = size === "hero";
  return (
    <div data-page-header className={cx("relative isolate overflow-hidden", hero && "flex min-h-72 flex-col justify-end sm:min-h-116", className)}>
      {photo !== undefined && (
        <>
          <Image src={photo} alt="" fill loading="eager" fetchPriority="high" sizes="(min-width: 1440px) 1440px, 100vw" className="object-cover" />
          <span
            aria-hidden="true"
            className={cx("absolute inset-0", hero ? "bg-linear-to-t from-bg via-bg/70 to-bg/10" : "bg-linear-to-b from-bg/70 via-bg/75 to-bg")}
          />
        </>
      )}
      {(photo === undefined || hero) && (
        <Filigree
          className={cx(
            "absolute",
            hero ? "top-1/2 -right-40 size-160 -translate-y-1/2 sm:right-0" : "-top-40 -right-36 size-112 sm:-top-56 sm:right-0 sm:size-160",
            // Sobre la foto, a la mitad: no compite con el cielo.
            photo !== undefined && "opacity-50",
          )}
        />
      )}
      <span aria-hidden="true" className="absolute inset-0 glow-header" />
      {/* La entrada anima solo lo que acompaña al título: el `<h1>` se pinta de inmediato, porque suele ser lo más
          grande que se ve al llegar y arrancarlo invisible retrasaba su pintado (LCP) los 480 ms de la entrada. */}
      <div className={cx("relative mx-auto flex w-full max-w-page flex-col gap-3 px-4 sm:px-8", hero ? "pt-24 pb-12 sm:pb-16" : "pt-12 pb-10 sm:pt-24 sm:pb-14")}>
        {eyebrow !== undefined && <p className="animate-enter eyebrow text-accent">{eyebrow}</p>}
        <h1 className={cx("max-w-reading text-text", hero ? "text-display-xl" : "text-display-l")}>{title}</h1>
        {lead !== undefined && <div className="max-w-reading animate-enter text-body-l text-text-2">{lead}</div>}
        {children}
      </div>
    </div>
  );
}
