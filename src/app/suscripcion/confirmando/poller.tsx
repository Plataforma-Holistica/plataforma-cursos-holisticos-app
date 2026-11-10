"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { plans as text } from "@/messages/es/plans";
import { Button } from "@/ui/button";

// PA-32 · la espera (T-302). Con JavaScript vuelve a pedir la página cada 3 s, y a los 20 s dice que está tardando; sin él, la página
// trae «Actualizar», que es un enlace a sí misma. Nunca da acceso: solo vuelve a preguntar.

export const EVERY_MS = 3_000;
export const SLOW_MS = 20_000;

export function ConfirmingPoller({ self }: { self: string }) {
  const router = useRouter();
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const ask = window.setInterval(() => router.refresh(), EVERY_MS);
    const late = window.setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      window.clearInterval(ask);
      window.clearTimeout(late);
    };
  }, [router]);

  return (
    <div className="flex flex-col gap-4">
      <div role="status" className="flex flex-col gap-2">
        <h1 className="text-h1">{slow ? text.slowTitle : text.confirmingTitle}</h1>
        <p className="text-body-l text-text-2">{slow ? text.slowBody : text.confirmingBody}</p>
      </div>
      <div>
        <Button href={self} variant="secondary" size="md">
          {text.refresh}
        </Button>
      </div>
    </div>
  );
}
