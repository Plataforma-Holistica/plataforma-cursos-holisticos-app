// La llegada a «Mi lista» del inicio desde la barra del alumno (T-616, solicitud 2). El enlace va por el enrutador
// (un `<a>` del navegador dejaba «Atrás» sin su estado, y Next lo ignoraba), así que el navegador no marca el bloque
// como `:target` ni avisa `hashchange`: el enlace lo avisa con este evento, y el bloque toma el foco y, sin nada
// guardado, lo dice.
export const MY_LIST_ARRIVAL = "mi-lista:llegada";
