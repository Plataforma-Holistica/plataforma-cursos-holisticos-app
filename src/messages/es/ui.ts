// Los textos que viven dentro de los componentes base (src/ui/). Es el único bloque que un
// componente importa: lo que una pantalla dice, se lo pasa la pantalla.
//
// Tono (diseño, sección 8): de tú, frases cortas, con punto final, sin admiraciones.
export const ui = {
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
    newTab: "Se abre en otra pestaña",
  },
  // El nombre de cada tono, para quien no ve el color ni el icono.
  alert: {
    neutral: "Nota",
    success: "Listo",
    warning: "Aviso",
    danger: "Error",
  },
  disclaimer: "{Plataforma} es educativa. No sustituye la atención médica ni psicológica profesional.",
} as const;
