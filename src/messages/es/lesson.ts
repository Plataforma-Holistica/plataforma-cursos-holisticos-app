import { defineMessages } from "../format";

// Los textos de la página de una lección (PA-22, T-203) y de lo que ocupa el lugar del
// reproductor: el cartel, la carga, los errores, el fin de la lección y PA-33. Los nombres de
// los controles del reproductor viven en su propio bloque (`player.ts`).
//
// Lo que todavía no existe no se promete: sin avance guardado (T-206), «No pudimos cargar el
// video» no dice «tu avance está guardado», y PA-33 no ofrece «Ver planes» hasta que exista la
// pantalla de planes (T-30x).
export const lesson = defineMessages({
  pageTitle: "Lección",
  back: "Volver al inicio",
  heading: "Lección {number} · {title}",
  byline: "{course} · {teacher}",
  tabsLabel: "Partes de la lección",
  syllabus: "Temario",
  about: "Sobre esta lección",
  aboutDuration: "Dura {duration}. Es del módulo «{module}».",
  minutes: "{minutes} min",
  player: {
    label: "Reproductor",
    play: "Reproducir la lección",
    noScript: "Para ver la lección hace falta JavaScript.",
    loading: "Preparando tu lección…",
    failed: "No pudimos cargar el video.",
    retry: "Reintentar",
    noVideo: "Esta lección no está disponible por ahora.",
    unavailable: "Algo falló de nuestro lado. No es por algo que hayas hecho.",
    ended: "Lección terminada",
    next: "Sigue: {title}",
    replay: "Volver a ver",
  },
  // PA-33: por qué no hay acceso, sin dramatizar.
  denied: {
    neverSubscribed: "Esta lección pide una suscripción",
    neverSubscribedText: "Con una suscripción ves todo el catálogo.",
    ended: "Tu acceso terminó el {date}",
    expiredText: "Para seguir viendo las lecciones, suscríbete de nuevo.",
    graceEndedText: "No pudimos cobrar tu suscripción.",
    refunded: "Tu suscripción fue reembolsada",
    refundedText: "Puedes volver cuando quieras.",
  },
});
