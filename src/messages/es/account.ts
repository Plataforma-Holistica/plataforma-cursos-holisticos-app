import { defineMessages } from "../format";

// Los textos de las pantallas de la cuenta (diseño, PA-10 a PA-15, PA-25, PA-35 y PA-07):
// registrarse, verificar el correo, entrar, recuperar la contraseña, completar la cuenta,
// administrarla, la cuenta suspendida y los textos legales.
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
    newPassword: "Contraseña nueva",
    // La regla de una contraseña nueva, a la vista desde antes de escribir.
    passwordRule: "{min} caracteres o más",
    // Para quien no ve la marca: se lee antes de la regla cuando ya se cumple.
    passwordRuleMet: "Cumplida:",
    passwordTooShort: "Tu contraseña necesita {min} caracteres o más.",
    passwordTooLong: "Esa contraseña es demasiado larga. Elige una más corta.",
    passwordInvalid: "Esa contraseña tiene caracteres que no podemos guardar. Elige otra.",
  },
  // Cuánto dura algo, dicho como se dice: «1 hora», «60 segundos».
  durations: {
    seconds: { one: "{count} segundo", other: "{count} segundos" },
    minutes: { one: "{count} minuto", other: "{count} minutos" },
    hours: { one: "{count} hora", other: "{count} horas" },
  },
  // PA-10.
  signUp: {
    pageTitle: "Crear cuenta",
    title: "Crea tu cuenta",
    hint: "Te mandamos un enlace para confirmar tu correo. Al abrirlo eliges tu contraseña.",
    submit: "Crear mi cuenta",
    submitting: "Enviando…",
    // «Antes de terminar vas a leer y aceptar los Términos y el Aviso de privacidad.»
    legalBefore: "Antes de terminar vas a leer y aceptar los",
    terms: "Términos",
    legalJoin: "y el",
    privacy: "Aviso de privacidad",
    legalEnd: ".",
    haveAccount: "Ya tengo cuenta",
    // El único tope que se dice: no delata nada de ningún correo.
    wait: "Espera un momento antes de intentarlo de nuevo.",
  },
  // PA-14, variante «Revisa tu correo».
  checkMail: {
    title: "Revisa tu correo",
    sentTo: "Te mandamos un enlace a {email}. Ábrelo para completar tu cuenta.",
    sentGeneric: "Te mandamos un enlace al correo que escribiste. Ábrelo para completar tu cuenta.",
    lasts: "Dura {duration}.",
    resend: "Reenviar",
    resending: "Reenviando…",
    resent: "Listo, lo mandamos otra vez.",
    resendWait: "Podrás reenviarlo en {duration}.",
    notMyEmail: "Ese no es mi correo",
    writeAgain: "Escribir mi correo otra vez",
    // «¿Ya tenías cuenta? Entra o recupera tu contraseña.»
    alreadyBefore: "¿Ya tenías cuenta?",
    alreadySignIn: "Entra",
    alreadyJoin: "o",
    alreadyRecover: "recupera tu contraseña",
    alreadyEnd: ".",
  },
  // PA-14, variante «Completa tu cuenta».
  complete: {
    title: "Completa tu cuenta",
    submit: "Confirmar mi correo",
    submitting: "Confirmando…",
    // «Acepto los Términos y el Aviso de privacidad.»
    acceptBefore: "Acepto los",
    acceptJoin: "y el",
    acceptEnd: ".",
    legalMissing: "Falta aceptar los Términos y el Aviso de privacidad.",
    historyMissing: "Falta tu permiso para guardar tu historial de cursos.",
    linkDeadTitle: "Ese enlace ya no sirve",
    linkDeadBody: "Puede que haya caducado o que ya se haya usado. Si ya completaste tu cuenta, entra con tu contraseña.",
    askAnother: "Pedir otro enlace",
    recoverPassword: "Recuperar mi contraseña",
    signIn: "Entrar",
    unfinishedTitle: "No pudimos terminar tu registro",
    unfinishedBody: "Tu correo ya quedó confirmado, pero tu cuenta no quedó lista y ese enlace ya se gastó. Elige tu contraseña desde «Recuperar mi contraseña»: al entrar te pedimos lo que falte.",
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
  // PA-13.
  recover: {
    pageTitle: "Recuperar contraseña",
    title: "Recupera tu contraseña",
    intro: "Escribe tu correo y te mandamos un enlace para elegir una contraseña nueva.",
    submit: "Mandarme el enlace",
    submitting: "Enviando…",
    // El mismo mensaje exista o no la cuenta, y se haya mandado algo o no.
    sent: "Si ese correo tiene cuenta, te mandamos un enlace.",
    sentLasts: "Si ese correo tiene cuenta, te mandamos un enlace. Dura {duration}.",
    noticeChoosePassword: "Para entrar a esta cuenta hay que elegir su contraseña desde tu correo.",
    backToSignIn: "Volver a entrar",
    changePageTitle: "Contraseña nueva",
    changeTitle: "Elige tu contraseña nueva",
    save: "Guardar contraseña",
    saving: "Guardando…",
    linkDeadTitle: "Ese enlace ya no sirve",
    linkDeadBody: "Puede que haya caducado o que ya se haya usado.",
    unfinishedTitle: "No pudimos terminar el cambio",
    unfinishedBody: "Ese enlace ya se gastó. Pide otro y vuelve a intentarlo.",
    askAnother: "Pedir otro",
  },
  // El inicio provisional, mientras no existe PA-20.
  home: {
    pageTitle: "Inicio",
    title: "Inicio",
    signedInAs: "Entraste como {email}.",
    status: "En construcción.",
    account: "Cuenta",
  },
  // PA-25. Por ahora, el nombre, el correo a la vista y las sesiones abiertas: la contraseña
  // llega en su propia solicitud, y cambiar de correo espera al correo propio (T-310).
  manage: {
    pageTitle: "Cuenta",
    title: "Cuenta",
    nameTitle: "Nombre",
    save: "Guardar",
    saving: "Guardando…",
    saved: "Guardado.",
    emailTitle: "Correo",
    emailNote: "Por ahora no se puede cambiar desde aquí.",
    backHome: "Volver al inicio",
    sessionsTitle: "Sesiones abiertas",
    sessionsIntro: "Los navegadores en los que tu cuenta tiene una sesión abierta.",
    // De qué navegador y sistema dijo ser cada sesión al abrirse: «Chrome en Windows».
    deviceOn: "{browser} en {system}",
    unknownBrowser: "Navegador desconocido",
    browsers: {
      chrome: "Chrome",
      edge: "Edge",
      firefox: "Firefox",
      safari: "Safari",
      opera: "Opera",
      samsung: "Samsung Internet",
    },
    systems: {
      windows: "Windows",
      macos: "macOS",
      linux: "Linux",
      android: "Android",
      ios: "iPhone o iPad",
      chromeos: "ChromeOS",
    },
    openedOn: "Se abrió el {date}.",
    lastActiveOn: "Última actividad: {date}.",
    thisSession: "Esta sesión",
    closeOne: "Cerrar",
    // Lo que sigue a «Cerrar» para quien no ve la fila: cada botón dice cuál sesión cierra.
    closeOneDetail: "la sesión de {device}, abierta el {date}",
    closeOthers: "Cerrar todas las demás",
    closingSessions: "Cerrando…",
    closedOne: "Cerramos esa sesión.",
    closedOthers: "Cerramos tus demás sesiones.",
    alreadyClosed: "Esa sesión ya estaba cerrada.",
    onlyThisSession: "No tienes otras sesiones abiertas.",
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
