import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { messages, t } from "@/messages";
import { SkipLink } from "@/ui/skip-link";
import "@/ui/theme.css";

import { displayFont, textFont } from "./fonts";

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

export const viewport: Viewport = {
  // Un solo tema, oscuro (diseño, D-03).
  colorScheme: "dark",
  // El token `--bg` de src/ui/theme.css. Aquí va escrito porque el navegador lo lee antes
  // que la hoja de estilos; tests/design/theme.test.ts comprueba que sean el mismo.
  themeColor: "#0F1019",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-MX" className={`${displayFont.variable} ${textFont.variable}`}>
      <body>
        <SkipLink />
        {children}
      </body>
    </html>
  );
}
