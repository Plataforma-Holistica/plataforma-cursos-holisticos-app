import { defineMessages } from "../format";

// Los recursos de un curso, como los ve quien los baja (RF-308; PA-02, PA-22 y PA-43; T-404). Va en su propio bloque: lo usan
// el catálogo, la lección y el portal, y ninguna de esas pantallas tiene por qué llevarse el bloque de otra al navegador.

export const resources = defineMessages({
  courseTitle: "Recursos del curso",
  lessonTitle: "Recursos de esta lección",
  tab: "Recursos",
  kindPdf: "PDF",
  kindDoc: "Word",
  kindAudio: "Audio",
  sizeKb: "{size} KB",
  sizeGb: "{size} GB",
  sizeMb: "{size} MB",
  detail: "{kind}, {size}",
  download: "Descargar",
  downloadNamed: "Descargar {title}",
  retry: "Reintentar",
  retryNamed: "Reintentar {title}",
  preparing: "Preparando…",
  started: "Tu descarga empezó.",
  gone: "Este recurso ya no está disponible.",
  throttled: "Pediste muchas descargas en poco tiempo. Vuelve a intentarlo en un rato.",
  unavailable: "No pudimos preparar la descarga. Intenta de nuevo.",
  neverSubscribed: "Este recurso pide una suscripción",
  signIn: "Entra a tu cuenta para descargarlos.",
  lessonUnavailable: "No pudimos leer los recursos de esta lección. Recarga la página para intentar de nuevo.",
});
