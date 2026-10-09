"use client";

import { useState } from "react";

import { Button } from "@/ui/button";
import { MAIN_CONTENT_ID } from "@/ui/skip-link";

// Página de muestra, solo en desarrollo (ver next.config.ts): un botón que rompe la
// pantalla a propósito, desde el navegador. Sirve para ver la pantalla de error (PA-18) y
// para comprobar que un error del navegador llega al registro de errores.
//
// El simulacro del lado del servidor es otra cosa: la ruta /api/error-drill.

function Broken(): never {
  throw new Error("Simulacro: esta pantalla se rompió a propósito desde el navegador.");
}

export default function ErrorSamplePage() {
  const [broken, setBroken] = useState(false);

  return (
    <main id={MAIN_CONTENT_ID} tabIndex={-1} className="mx-auto flex max-w-form flex-col gap-6 px-4 py-16 outline-none">
      <p className="text-label text-text-3 uppercase">Solo en desarrollo</p>
      <h1 className="text-h1">Romper la pantalla</h1>
      <p className="text-body-l text-text-2">
        El botón lanza un error al dibujar. Debe aparecer la pantalla de error, sin el
        mensaje técnico.
      </p>
      <Button variant="danger" onClick={() => setBroken(true)}>
        Romper esta pantalla
      </Button>
      {broken && <Broken />}
    </main>
  );
}
