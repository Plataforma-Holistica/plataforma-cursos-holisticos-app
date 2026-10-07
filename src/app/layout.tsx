import type { Metadata } from "next";
import type { ReactNode } from "react";

import { messages } from "@/messages/es";

export const metadata: Metadata = {
  title: messages.app.name,
  // Nada se indexa mientras la Plataforma no se lance. Al lanzar, solo el sitio público
  // es indexable (RF-902).
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
