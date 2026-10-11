import { defineMessages } from "../format";

// Los textos de las pantallas de la cuenta (diseño, PA-11, PA-15, PA-35 y PA-07): entrar,
// completar la cuenta, la cuenta suspendida y los textos legales.
//
// Tono (diseño, sección 8): de tú, frases cortas, con punto final, sin admiraciones. Un
// mensaje de error dice qué pasó y cómo se arregla, y nunca revela si un correo tiene
// cuenta: «El correo o la contraseña no coinciden.» es el mismo para todos los casos.
//
// Varios textos de «no disponible» no venían en las fichas del diseño, que solo cubrían el
// caso de la contraseña filtrada: se redactaron aquí y se agregaron al diseño.
export const account = defineMessages({
  common: {
    unavailable: "No pudimos hacerlo. Intenta de nuevo en un momento.",
    signOut: "Salir",
    closeSession: "Cerrar sesión",
    closingSession: "Cerrando…",
    goHome: "Ir al inicio",
    retry: "Reintentar",
  },
  fields: {
    email: "Correo",
    password: "Contraseña",
    name: "Nombre",
    emailRequired: "Escribe tu correo.",
    emailInvalid: "Ese correo no tiene forma de correo. Revísalo.",
    passwordRequired: "Escribe tu contraseña.",
    nameRequired: "Escribe tu nombre.",
    nameTooLong: "Ese nombre es demasiado largo. Escribe uno más corto.",
    nameInvalid: "Ese nombre tiene caracteres que no podemos guardar. Escríbelo de nuevo.",
  },
  // PA-11.
  signIn: {
    pageTitle: "Iniciar sesión",
    title: "Inicia sesión",
    submit: "Entrar",
    submitting: "Entrando…",
    forgot: "Olvidé mi contraseña",
    createAccount: "Crear cuenta",
    invalidCredentials: "El correo o la contraseña no coinciden.",
    // La hora, en la del navegador.
    throttled: "Demasiados intentos. Podrás probar de nuevo a las {time}.",
    // Sin JavaScript no se sabe en qué zona está la persona: se dice cuál es.
    throttledCentral: "Demasiados intentos. Podrás probar de nuevo a las {time}, hora del centro de México.",
    capped: "Demasiados intentos. Vuelve a probar más tarde.",
    lockedReason: "Podrás intentarlo de nuevo cuando pase la espera.",
    noticePasswordChanged: "Tu contraseña se cambió y cerramos todas tus sesiones. Entra con la nueva.",
    noticeAccountReady: "Tu cuenta está lista. Entra con tu contraseña.",
  },
  // PA-13, lo que la entrada necesita decir al mandar ahí.
  recover: {
    noticeChoosePassword: "Para entrar a esta cuenta hay que elegir su contraseña desde tu correo.",
  },
  // El inicio provisional, mientras no existe PA-20.
  home: {
    pageTitle: "Inicio",
    title: "Inicio",
    signedInAs: "Entraste como {email}.",
    status: "En construcción.",
  },
  // PA-15.
  consents: {
    pageTitle: "Antes de seguir",
    titleComplete: "Completa tu cuenta",
    titleUpdated: "Actualizamos nuestros textos",
    introComplete: "Antes de seguir nos falta esto de tu cuenta.",
    introUpdated: "Cambió un texto que ya habías aceptado. Léelo y acéptalo para seguir.",
    submit: "Aceptar y seguir",
    submitting: "Guardando…",
    adult: "Tengo {age} años cumplidos o más.",
    accept: "Leí y acepto: {title}.",
    textDetails: "Versión {version}, vigente desde el {date}.",
    readText: "Leer el texto",
    historyGrant: "Doy mi permiso para que {Plataforma} guarde mi historial de cursos con esos fines.",
    textsChanged: "Actualizamos un texto mientras llenabas el formulario. Léelo y marca de nuevo.",
    adultMissing: "Falta que declares tu edad.",
    textMissing: "Falta aceptar: {title}.",
    noCurrentText: "Por ahora no podemos completar tu cuenta.",
    noCurrentTextTitle: "No podemos completar tu cuenta",
  },
  // PA-35. La frase de la renovación cancelada entra con la tarea que la cancele, y el
  // contacto, con la página de ayuda (PA-06).
  suspended: {
    title: "Tu cuenta está suspendida",
    body: "No puedes entrar por ahora.",
  },
  // PA-07, en su versión mínima.
  legal: {
    details: "Versión {version} · vigente desde el {date}",
    draft: "Borrador sin validez legal. Solo existe en una base de desarrollo.",
  },
});
