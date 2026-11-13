// El registro de créditos de las fotos de ambiente (diseño, sección 3.12; T-614). Una fila por archivo de
// esta carpeta, con su fuente, autor, licencia, enlace y fecha de descarga: tests/design/brand.test.ts
// exige que ninguna foto quede sin la suya, y ninguna fila sin su foto.
//
// Las eligió Sergio el 2026-11-05, de las candidatas de Pexels con el criterio del diseño: naturaleza y
// luz en calma, tonos fríos, sin personas reconocibles, sin símbolos ni texto. Bajadas a 2 400 px de
// ancho (1 600 las de práctica) con la compresión de Pexels; Next las sirve después en AVIF y WebP, al
// ancho de cada lugar. No son textos de la interfaz: el título es el de la fuente, para encontrarla.
//
// Cambiar una foto es reemplazar su archivo y su fila.

export const LICENSES = {
  Pexels: "Licencia de Pexels: uso comercial, sin atribución obligatoria (https://www.pexels.com/license/)",
  Unsplash: "Licencia de Unsplash: uso comercial, sin atribución obligatoria (https://unsplash.com/license)",
} as const;

/**
 * Dónde va cada foto (diseño, sección 3.12): la portada, el acceso, la cabecera del inicio, la de explorar y las fichas por
 * práctica. Desde T-616 (solicitud 3) el faro dejó la cabecera del inicio, que lleva siempre las estrellas, y va en la de explorar.
 */
export type PhotoPlace = "portada" | "acceso" | "inicio" | "explorar" | "practica";

export interface PhotoCredit {
  file: string;
  place: PhotoPlace;
  title: string;
  source: keyof typeof LICENSES;
  author: string;
  license: (typeof LICENSES)[keyof typeof LICENSES];
  url: string;
  /** Fecha de descarga, AAAA-MM-DD. */
  downloaded: string;
}

export const PHOTO_CREDITS: readonly PhotoCredit[] = [
  {
    file: "portada-muelle.jpg",
    place: "portada",
    title: "Serene Morning at Seeon Lake Pier",
    source: "Pexels",
    author: "Tommes Frites",
    license: LICENSES.Pexels,
    url: "https://www.pexels.com/photo/serene-morning-at-seeon-lake-pier-30990782/",
    downloaded: "2026-11-05",
  },
  {
    file: "acceso-ondas.jpg",
    place: "acceso",
    title: "Ripple of Waves on Dark Water",
    source: "Pexels",
    author: "Tim Mossholder",
    license: LICENSES.Pexels,
    url: "https://www.pexels.com/photo/ripple-of-waves-on-dark-water-9398212/",
    downloaded: "2026-11-05",
  },
  {
    file: "explorar-faro.jpg",
    place: "explorar",
    title: "Lighthouse on the Ocean",
    source: "Pexels",
    author: "Денис Нагайцев",
    license: LICENSES.Pexels,
    url: "https://www.pexels.com/photo/lighthouse-on-the-ocean-10165750/",
    downloaded: "2026-11-05",
  },
  {
    file: "inicio-estrellas.jpg",
    place: "inicio",
    title: "Abstract background of night blue sky with shiny stars",
    source: "Pexels",
    author: "Wayne Speedy",
    license: LICENSES.Pexels,
    url: "https://www.pexels.com/photo/abstract-background-of-night-blue-sky-with-shiny-stars-4135374/",
    downloaded: "2026-11-05",
  },
  {
    file: "practica-ventana.jpg",
    place: "practica",
    title: "A Desk with a Flower Vase by the Window",
    source: "Pexels",
    author: "phuong nguyen",
    license: LICENSES.Pexels,
    url: "https://www.pexels.com/photo/a-desk-with-a-flower-vase-by-the-window-14149574/",
    downloaded: "2026-11-05",
  },
  {
    file: "practica-cortina.jpg",
    place: "practica",
    title: "Sunlight Patterns on Curtain and Chair",
    source: "Pexels",
    author: "Alexander Zvir",
    license: LICENSES.Pexels,
    url: "https://www.pexels.com/photo/sunlight-patterns-on-curtain-and-chair-39002189/",
    downloaded: "2026-11-05",
  },
];
