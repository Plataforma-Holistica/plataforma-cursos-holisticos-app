import { defineMessages } from "../format";

// Los textos de las pantallas que no son de ninguna superficie: la portada provisional y
// los estados que sustituyen a la pantalla pedida (diseño, PA-18 y PA-19).
export const states = defineMessages({
  home: {
    status: "En construcción.",
  },
  // PA-19. Es idéntica para una dirección que no existe, para un curso despublicado y para
  // una ruta de otro rol: no revela cuál de las tres es (RF-105).
  notFound: {
    title: "No encontramos esa página",
    body: "Puede que la dirección esté mal o que ya no esté disponible.",
    home: "Ir al inicio",
  },
  // PA-18. Sin detalles técnicos: solo un código corto para dictarlo a soporte.
  error: {
    title: "Algo falló de nuestro lado",
    body: "No es por algo que hayas hecho. Ya nos llegó el aviso.",
    retry: "Reintentar",
    home: "Ir al inicio",
    reference: "Código de referencia: {code}",
  },
});
