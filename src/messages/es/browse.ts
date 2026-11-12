import { defineMessages } from "../format";

// Los textos del catálogo del alumno (T-210): la barra del alumno, el inicio (PA-20), la ficha
// de un curso (PA-02) y la de un maestro (PA-03).
//
// Lo que todavía no existe no se promete: sin la pantalla de planes (T-30x) el botón del
// visitante lleva a registrarse; sin constancias (T-504), quien terminó un curso lo vuelve a ver.
export const browse = defineMessages({
  nav: {
    label: "Principal",
    home: "Inicio",
    explore: "Explorar",
    myList: "Mi lista",
    account: "Cuenta",
    // Los accesos por rol (T-616): solo a quien es maestro o del equipo.
    portal: "Mi portal",
    admin: "Administración",
    // El menú de la persona.
    menu: "Tu cuenta",
    myComments: "Mis comentarios",
    signOut: "Cerrar sesión",
  },
  minutes: "{minutes} min",
  hoursMinutes: "{hours} h {minutes} min",
  hours: { one: "{hours} hora", other: "{hours} horas" },
  home: {
    pageTitle: "Inicio",
    greeting: "Hola, {name}",
    invitationGone: "Esa invitación ya no sirve. Pide que te manden otra.",
    greetingAnonymous: "Hola",
    continueTitle: "Continuar viendo",
    startersTitle: "Para empezar",
    // El protagonista (T-616, solicitud 3): el botón de quien no ha empezado, y los demás en filas, con el resto plegado.
    seeCourse: "Ver el curso",
    moreRows: { one: "Ver uno más", other: "Ver los otros {count}" },
    newestTitle: "Nuevos",
    // Las prácticas como fichas, que llevan a explorar con su filtro (T-616).
    practicesTitle: "Prácticas",
    practiceCount: { one: "{count} curso", other: "{count} cursos" },
    practiceTile: "{name}, {count}",
    teachersTitle: "Por {maestro}",
    empty: "Estamos preparando los primeros cursos.",
    emptyLead: "Cuando se publiquen, aparecen aquí.",
    unavailable: "No pudimos cargar los cursos. Inténtalo de nuevo en un momento.",
    retry: "Reintentar",
    seeAll: "Ver todo",
    seeAllOf: "Ver todo: {row}",
  },
  // Explorar y buscar (PA-21). Los filtros y la búsqueda viven en la dirección.
  explore: {
    pageTitle: "Explorar",
    heading: "Explorar",
    // La cabecera (T-616).
    eyebrow: "El catálogo",
    lead: "Busca por curso o por {maestro}, o recorre cada práctica.",
    searchLabel: "Buscar por curso o {maestro}",
    search: "Buscar",
    clearSearch: "Borrar la búsqueda",
    filters: "Filtros",
    practice: "Práctica",
    teacher: "{Maestro}",
    level: "Nivel",
    anyPractice: "Todas las prácticas",
    anyTeacher: "Todos {los_maestros}",
    anyLevel: "Todos los niveles",
    activeFilters: "Filtros activos",
    removeFilter: "Quitar filtro: {name}",
    clearFilters: "Limpiar filtros",
    count: { one: "{count} curso", other: "{count} cursos" },
    resultsTitle: "Resultados",
    // Sin filtro ni búsqueda, una sola rejilla, ordenada por práctica (T-616).
    allTitle: "Todos los cursos",
    teachersTitle: "{Maestros}",
    empty: "No encontramos cursos con esos filtros.",
    selectionTitle: "Nuevos",
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
  // Mi lista (RF-311): el carrusel del inicio y el botón de la ficha y de explorar. El texto
  // visible dice la acción; el nombre para quien no ve lleva además el curso.
  myList: {
    title: "Mi lista",
    // Solo al llegar por «Mi lista» de la barra, sin nada guardado (T-616): un estado con la flor, su título y qué hacer.
    emptyHereTitle: "Todavía no guardas ningún curso.",
    emptyHere: "Usa «Guardar en mi lista» en la ficha de un curso o en Explorar.",
    save: "Guardar en mi lista",
    remove: "Quitar de mi lista",
    removeShort: "Quitar",
    saveNamed: "Guardar en mi lista: {title}",
    removeNamed: "Quitar de mi lista: {title}",
    saving: "Guardando…",
    removing: "Quitando…",
    saved: "Guardado en tu lista.",
    removed: "Quitado de tu lista.",
    gone: "Ese curso ya no está disponible.",
    unavailable: "No pudimos cambiar tu lista. Inténtalo de nuevo en un momento.",
  },
});
