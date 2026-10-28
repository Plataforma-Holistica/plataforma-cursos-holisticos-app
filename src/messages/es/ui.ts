import { defineMessages } from "../format";

// Los textos que viven dentro de los componentes base (src/ui/). Es el único bloque que un
// componente importa: lo que una pantalla dice, se lo pasa la pantalla.
//
// Tono (diseño, sección 8): de tú, frases cortas, con punto final, sin admiraciones.
export const ui = defineMessages({
  skipLink: "Saltar al contenido",
  field: {
    optional: "(opcional)",
  },
  password: {
    show: "Mostrar",
    hide: "Ocultar",
    showLabel: "Mostrar la contraseña",
    hideLabel: "Ocultar la contraseña",
  },
  spinner: {
    loading: "Cargando…",
  },
  formErrors: {
    one: "Hay {count} dato por corregir",
    other: "Hay {count} datos por corregir",
  },
  consent: {
    required: "Para seguir hace falta que aceptes esto.",
  },
  link: {
    newTab: "(se abre en otra pestaña)",
  },
  // El nombre de cada tono, para quien no ve el color ni el icono. Se lee antes del
  // mensaje, y por eso lleva sus dos puntos.
  alert: {
    neutral: "Nota:",
    success: "Listo:",
    warning: "Aviso:",
    danger: "Error:",
  },
  // Una lección del temario: el nombre del enlace dice su número, su título, su duración y su
  // estado (T-206). A la vista va lo mismo, sin «Lección».
  lessonRow: {
    name: "Lección {number}, {title}, {duration}",
    nameInProgress: "Lección {number}, {title}, {duration}, a medias",
    nameCompleted: "Lección {number}, {title}, {duration}, terminada",
    namePlaying: "Lección {number}, {title}, {duration}, reproduciendo",
    nameCompletedPlaying: "Lección {number}, {title}, {duration}, terminada, reproduciendo",
    durationInProgress: "{duration} · A medias",
    durationCompleted: "{duration} · Terminada",
    durationPlaying: "{duration} · Reproduciendo",
    durationCompletedPlaying: "{duration} · Terminada · Reproduciendo",
  },
  // La cifra sin dato (diseño, sección 5): nunca un cero que no se midió.
  stat: {
    noData: "Sin datos todavía",
    // La cifra en tono de atención, para quien no ve el color ni el icono.
    attention: "Pasa el umbral:",
  },
  // El diálogo irreversible lo dice también con palabras, no solo con el color del botón.
  dialog: {
    irreversible: "Acción irreversible",
  },
  disclaimer: "{Plataforma} es educativa. No sustituye la atención médica ni psicológica profesional.",
});
