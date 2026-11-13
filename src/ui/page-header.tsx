import Image, { type StaticImageData } from "next/image";
import type { ReactNode, Ref } from "react";

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
// El título es el `<h1>` de la pantalla. Con `titleRef` (3b-3), la pantalla le lleva el foco por programa: cuando lo
// pulsado se va con la respuesta («Mis comentarios», después de borrar).

export interface PageHeaderProps {
  title: ReactNode;
  /** El `<h1>` recibe el foco por programa (`tabIndex={-1}`, sin contorno): cuando lo pulsado se va con la respuesta. */
  titleRef?: Ref<HTMLHeadingElement>;
  /** Lo que va arriba del antetítulo, dentro de la cabecera: «Volver a…». */
  above?: ReactNode;
  eyebrow?: string;
  /** Lo que acompaña al título, en el segundo tono. */
  lead?: ReactNode;
  photo?: StaticImageData;
  size?: "regular" | "hero";
  /** Lo que va debajo, dentro de la cabecera (un buscador, una línea más). */
  children?: ReactNode;
  className?: string;
}

export function PageHeader({ title, titleRef, above, eyebrow, lead, photo, size = "regular", children, className }: PageHeaderProps) {
  const hero = size === "hero";
  const focusable = titleRef !== undefined && titleRef !== null;
  return (
    // La alta mide 368 px en computadora (T-616, solicitud 3: la cabecera del inicio a 360–380 px, para que el protagonista
    // quede en la primera pantalla) y 224 en el teléfono, con menos aire: a 390 × 844 el botón del protagonista cabe sin bajar.
    <div data-page-header className={cx("relative isolate overflow-hidden", hero && "flex min-h-56 flex-col justify-end sm:min-h-92", className)}>
      {photo !== undefined && (
        <>
          <Image src={photo} alt="" fill loading="eager" fetchPriority="high" sizes="(min-width: 1440px) 1440px, 100vw" className="object-cover" />
          <span
            aria-hidden="true"
            // El velo, lo justo para que todo el texto (la entradilla en `text-2` y el antetítulo en oro) pase 4.5 sobre un
            // píxel blanco de la foto, con el resplandor encima (3b-1 y su revisión; medido en tests/design/contrast.test.ts, que
            // lee estas clases): con 75 % y el resplandor, `text-2` da 4.77 y el oro 5.34 (a 70 % y sin contar el resplandor,
            // `text-2` daba 4.09). En la normal, de 75 % arriba al fondo pleno abajo. En la alta, del fondo abajo a 75 % al 80 %
            // de su alto: el texto empieza bajo su aire de arriba y, en el teléfono, con un saludo de dos renglones, llega hasta
            // ahí; arriba, la foto se ve.
            className={cx("absolute inset-0", hero ? "bg-linear-to-t from-bg via-bg/75 via-80% to-bg/10" : "bg-linear-to-b from-bg/75 to-bg")}
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
      <div className={cx("relative mx-auto flex w-full max-w-page flex-col gap-3 px-4 sm:px-8", hero ? "pt-16 pb-8 sm:pt-24 sm:pb-16" : "pt-12 pb-10 sm:pt-24 sm:pb-14")}>
        {/* No se estira en la columna: el enlace mide su texto, no toda la fila. */}
        {above !== undefined && <div className="self-start">{above}</div>}
        {eyebrow !== undefined && <p className="animate-enter eyebrow text-accent">{eyebrow}</p>}
        <h1
          ref={titleRef}
          tabIndex={focusable ? -1 : undefined}
          className={cx("max-w-reading text-text", hero ? "text-display-xl" : "text-display-l", focusable && "outline-none")}
        >
          {title}
        </h1>
        {lead !== undefined && <div className="max-w-reading animate-enter text-body-l text-text-2">{lead}</div>}
        {children !== undefined && <div className="animate-enter">{children}</div>}
      </div>
    </div>
  );
}
