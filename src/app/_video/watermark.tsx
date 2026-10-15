"use client";

import { useEffect, useRef, useState } from "react";

import { nextWatermarkCell, WATERMARK_FADE_MS, WATERMARK_INTERVAL_MS, type WatermarkCell } from "./watermark-cells";

// La marca de agua del reproductor (diseño, sección 5.4; RF-305): el correo de quien ve, tenue,
// que cambia de celda cada 30 segundos, desvaneciéndose, y deriva despacio dentro de la celda.
// Con movimiento reducido no deriva y cambia de golpe (eso lo hace `theme.css`). No se lee
// (`aria-hidden`), no se selecciona y no recibe el toque.
//
// Es disuasión, no candado: alguien con conocimientos la puede ocultar. Lo que se hace es que,
// si desaparece o se oculta, el video se pause (TRD §9.4). Quien la vigila es el reproductor,
// con `watermarkIntact`.

// Las clases de cada celda, escritas enteras: Tailwind no ve una clase armada con texto.
const CELL_CLASSES: Record<WatermarkCell, string> = {
  0: "watermark-cell-0",
  1: "watermark-cell-1",
  2: "watermark-cell-2",
  3: "watermark-cell-3",
  5: "watermark-cell-5",
  6: "watermark-cell-6",
  7: "watermark-cell-7",
  8: "watermark-cell-8",
};

/** Si la opacidad del elemento está a medio camino de una transición suya (el navegador la lleva). */
function opacityInTransition(element: HTMLElement): boolean {
  const running = element.getAnimations?.() ?? [];
  return running.some(
    (animation) =>
      animation.playState === "running" && (animation as Animation & { transitionProperty?: string }).transitionProperty === "opacity",
  );
}

/**
 * Si la marca sigue en su lugar: dentro del contenedor, visible, sin desvanecer a mano y con su
 * texto. Durante su propio desvanecido la opacidad no cuenta, y tampoco mientras el navegador
 * todavía la lleva de vuelta: la transición empieza un cuadro después de que React quita la
 * clase, así que puede seguir corriendo cuando el periodo protegido ya terminó.
 */
export function watermarkIntact(element: HTMLElement | null, frame: HTMLElement | null, text: string, fading: boolean): boolean {
  if (element === null || frame === null || !frame.contains(element)) return false;
  if (element.textContent !== text) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || element.hidden) return false;
  if (fading || style.opacity === "" || Number(style.opacity) >= 1) return true;
  return opacityInTransition(element);
}

export interface WatermarkProps {
  text: string;
  /** El elemento, para que el reproductor lo vigile. */
  elementRef: React.RefObject<HTMLParagraphElement | null>;
  /** Si va a media vuelta: mientras, su opacidad no cuenta. */
  fadingRef: React.RefObject<boolean>;
  /** Se movió de celda: el reproductor revisa que siga en su lugar. */
  onMoved: () => void;
}

export function Watermark({ text, elementRef, fadingRef, onMoved }: WatermarkProps) {
  const [cell, setCell] = useState<WatermarkCell>(() => nextWatermarkCell(null, Math.random));
  const [fading, setFading] = useState(false);
  const moved = useRef(onMoved);
  useEffect(() => {
    moved.current = onMoved;
  });

  useEffect(() => {
    let out: ReturnType<typeof setTimeout> | undefined;
    let back: ReturnType<typeof setTimeout> | undefined;
    const every = setInterval(() => {
      // Mientras se va y mientras vuelve, su opacidad está a medio camino: no cuenta.
      fadingRef.current = true;
      setFading(true);
      out = setTimeout(() => {
        setCell((current) => nextWatermarkCell(current, Math.random));
        setFading(false);
        back = setTimeout(() => {
          fadingRef.current = false;
          moved.current();
        }, WATERMARK_FADE_MS);
      }, WATERMARK_FADE_MS);
    }, WATERMARK_INTERVAL_MS);
    return () => {
      clearInterval(every);
      if (out !== undefined) clearTimeout(out);
      if (back !== undefined) clearTimeout(back);
    };
  }, [fadingRef]);

  return (
    <p ref={elementRef} data-watermark aria-hidden="true" translate="no" className={`watermark ${CELL_CLASSES[cell]}${fading ? " opacity-0" : ""}`}>
      {text}
    </p>
  );
}
