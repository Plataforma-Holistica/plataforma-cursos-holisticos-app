import { defineMessages } from "../format";

// Los textos del catálogo del alumno (T-210): la barra del alumno, el inicio (PA-20), la ficha
// de un curso (PA-02) y la de un maestro (PA-03).
//
// Lo que todavía no existe no se promete: sin la pantalla de planes (T-30x) el botón del
// visitante lleva a registrarse; sin constancias (T-504), quien terminó un curso lo vuelve a ver.
export const browse = defineMessages({
  nav: {
    label: "Principal",
    // El nombre del producto, como marca de la barra, mientras no haya logotipo (PQ-13).
    brand: "{Plataforma}",
    home: "Inicio",
    account: "Cuenta",
  },
  minutes: "{minutes} min",
  hoursMinutes: "{hours} h {minutes} min",
  hours: { one: "{hours} hora", other: "{hours} horas" },
  home: {
    pageTitle: "Inicio",
    greeting: "Hola, {name}",
    greetingAnonymous: "Hola",
    continueTitle: "Continuar viendo",
    startersTitle: "Para empezar",
    newestTitle: "Nuevos",
    teachersTitle: "Por {maestro}",
    empty: "Estamos preparando los primeros cursos.",
    unavailable: "No pudimos cargar los cursos. Inténtalo de nuevo en un momento.",
    retry: "Reintentar",
  },
  course: {
    pageTitle: "Curso",
    back: "Volver al inicio",
    lessonsLine: { one: "{count} lección · {duration}", other: "{count} lecciones · {duration}" },
    start: "Empezar",
    continue: "Continuar: lección {number}",
    again: "Volver a ver",
    subscribe: "Suscribirme para verlo",
    openFree: "Verlo sin costo",
    openNotice: "Este es el curso abierto: lo puedes ver sin suscripción, con tu cuenta.",
    progressLabel: "Avance del curso",
    progress: { one: "{completed} de {total} lección terminada", other: "{completed} de {total} lecciones terminadas" },
    syllabus: "Temario",
    moduleTitle: "Módulo {number} · {title}",
    about: "Sobre {name}",
    seeTeacher: "Ver la ficha de {name}",
  },
  teacher: {
    pageTitle: "{Maestro}",
    courses: "Cursos de {name}",
  },
});
