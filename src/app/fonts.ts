import { Bricolage_Grotesque, Source_Sans_3 } from "next/font/google";

// MARCA: las dos tipografías (diseño, sección 3.5). Una grotesca de carácter para títulos
// y una humanista neutra para texto. Dos familias, nunca tres. Son provisionales: cambian
// aquí cuando exista la identidad.
//
// `next/font` las baja al compilar y las sirve desde el propio dominio: el navegador no le
// pide nada a Google. Trae `swap` y ajusta las métricas de la fuente de respaldo, para que
// la página no brinque cuando llegan.
//
// Cada una deja su variable en `<html>`; src/ui/theme.css las toma de ahí. Son variables,
// así que los pesos 400, 600 y 700 salen del mismo archivo.

/** Títulos. Con el eje de tamaño óptico, que afina la letra en los tamaños grandes. */
export const displayFont = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
  variable: "--brand-font-display",
});

/** Texto. */
export const textFont = Source_Sans_3({
  subsets: ["latin"],
  display: "swap",
  variable: "--brand-font-text",
});
