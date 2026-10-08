import type { Metadata } from "next";
import type { ReactNode } from "react";

import { messages, t } from "@/messages";
import "@/ui/theme.css";

export const metadata: Metadata = {
  // Cada pantalla pone su nombre y aquí se le agrega el de la Plataforma.
  title: {
    default: t(messages.meta.titleDefault),
    template: t(messages.meta.titleTemplate, { page: "%s" }),
  },
  // Nada se indexa mientras la Plataforma no se lance. Al lanzar, solo el sitio público
  // es indexable (RF-902).
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-MX">
      <body>{children}</body>
    </html>
  );
}
