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
    // Al cambiarla desde la cuenta: la nueva es la que ya se tenía, o Auth no la aceptó.
    passwordSame: "Esa es la contraseña que ya tienes. Elige otra.",
    passwordWeak: "Esa contraseña es fácil de adivinar. Elige otra.",
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
    // El cambio desde la cuenta se quedó sin respuesta: no se sabe cuál de las dos vale.
    noticePasswordUnconfirmed:
      "No pudimos confirmar si tu contraseña cambió, y cerramos todas tus sesiones. Entra con la nueva; si no funciona, usa la de antes.",
    // Aceptó su invitación configurando el segundo factor: su sesión se cerró al aceptar.
    noticeSecondFactorReady: "Tu segundo factor quedó configurado. Entra con tu contraseña y escribe el código de tu aplicación.",
    // El freno de los códigos rechazó: Auth cerró todas las sesiones de la cuenta.
    noticeSecondFactorThrottled:
      "Hubo demasiados códigos equivocados y cerramos tus sesiones. Espera unos minutos y entra de nuevo. Si no fuiste tú, recupera tu contraseña desde tu correo.",
    noticeSessionEnded: "Tu sesión se cerró. Entra de nuevo para continuar.",
    // Alguien del equipo se quitó una capacidad a sí misma (PA-86).
    noticeCapabilityRemoved: "Quitaste una de tus capacidades y cerramos todas tus sesiones. Entra de nuevo.",
  },
  // PA-12, pedir: el código del segundo factor de quien es del equipo y entra.
  secondFactor: {
    title: "Escribe tu código",
    body: "Ábrelo en tu aplicación de códigos.",
    code: "Código",
    codeHint: "Los seis dígitos que muestra tu aplicación.",
    codeRequired: "Escribe tu código.",
    codeInvalid: "El código son seis dígitos. Revísalo.",
    wrongCode: "Ese código no coincide. Revisa que sea el más reciente.",
    submit: "Continuar",
    submitting: "Comprobando…",
    goHome: "Ir a mi inicio",
    // Conserva sus capacidades, perdió su atadura y no tiene una invitación viva.
    unboundTitle: "Tu segundo factor ya no está",
    unboundBody:
      "Se restableció y no tienes una invitación vigente para configurarlo de nuevo. Pide a alguien del equipo con configuración que te mande otra.",
  },
  // PA-12, configurar: ahí se acepta una invitación de administración.
  factorSetup: {
    title: "Configura tu segundo factor",
    intro: "Para entrar a administración necesitas una aplicación de códigos en tu teléfono. Al configurarla aceptas tu invitación.",
    start: "Empezar",
    starting: "Preparando…",
    // Recargar sin JavaScript reenvía «Empezar» y cambia la clave: se dice antes.
    startNote: "Al empezar te mostramos una clave, una sola vez. Si recargas la página o empiezas de nuevo, la clave cambia y la anterior deja de servir.",
    stepScan: "Escanea el código con tu aplicación, o copia la clave.",
    stepCode: "Escribe el código que te da la aplicación.",
    qrAlt: "Código QR con la clave de tu segundo factor",
    secretLabel: "Clave en texto",
    openInApp: "Abrir en mi aplicación de códigos",
    handoff: "Código que te dictaron",
    handoffHint: "Te lo dicta quien restableció tu segundo factor.",
    handoffRequired: "Escribe el código que te dictaron.",
    handoffWrong: "Ese código no coincide con el que te dictaron. Pídelo de nuevo.",
    submit: "Continuar",
    submitting: "Comprobando…",
    startAgain: "Empezar de nuevo",
    // La clave que la persona tiene delante ya no es la vigente: otra pestaña empezó de
    // nuevo, pasó demasiado tiempo, o el factor ya no existe.
    startAgainNotice: "Esa clave ya no es la vigente. Empieza de nuevo para ver una nueva.",
    // Ya hay un factor a medias en ese navegador, y la clave no se vuelve a mostrar.
    resumeBody: "Ya empezaste a configurarlo en este navegador. Escribe el código de tu aplicación. Si ya no tienes la clave a la vista, empieza de nuevo.",
    proveTitle: "Primero abre el enlace de tu correo",
    proveBody:
      "Para configurar tu segundo factor necesitamos confirmar que el buzón es tuyo. Recupera tu contraseña y abre el enlace en este mismo navegador. Si cierras sesión aquí, tendrás que repetirlo.",
    proveAction: "Recuperar mi contraseña",
    // La cuenta ya tiene un factor verificado que nadie ató: Auth no deja dar de alta otro.
    secondLevel: "Tu cuenta ya tiene un segundo factor que no quedó ligado a tu invitación. Recupera tu contraseña desde tu correo, en este navegador, y vuelve a empezar.",
  },
  // PA-60, en su versión mínima: todavía no existe ninguna de sus tareas.
  admin: {
    title: "Administración",
    noPending: "No tienes pendientes.",
    capabilitiesTitle: "Tus capacidades",
    // PA-86. Solo se le ofrece a quien tiene configuración.
    team: "Equipo de administración",
    // PA-67. Solo se le ofrece a quien tiene Contenido.
    catalog: "Prácticas y niveles",
    // PA-61. Solo se le ofrece a quien tiene Contenido.
    review: "Cursos por revisar",
    // PA-68. Solo se le ofrece a quien tiene finanzas.
    alerts: "Alertas de anomalía",
    // PA-78. Solo se le ofrece a quien tiene finanzas.
    periods: "Periodos",
    // PA-89. Solo se le ofrece a quien tiene configuración.
    legalTexts: "Textos legales",
    account: "Cuenta",
    teacherInvitation: "Tienes una invitación como {maestro}: revísala",
    capabilities: {
      content: "Contenido",
      finance: "Finanzas",
      moderation: "Moderación",
      support: "Soporte",
      config: "Configuración",
    },
  },
  // PA-88. Sin los nombres de quién puede asignarla: solo quien tiene configuración lee las
  // capacidades de otras personas.
  forbidden: {
    title: "Esta sección pide la capacidad de {capability}",
    body: "La asigna quien tiene configuración.",
    action: "Ir al inicio de administración",
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
    // «Continuar viendo» (T-206), mínima hasta PA-20 (T-210): los cursos empezados y sin
    // terminar, con la lección sugerida.
    continueTitle: "Continuar viendo",
    continueName: "{course}, con {teacher}: lección {number} de {total}, {lesson}",
    continueLesson: "Lección {number} de {total} · {lesson}",
    continueProgressLabel: "Avance de {course}",
    continueProgress: { one: "{completed} de {total} lección", other: "{completed} de {total} lecciones" },
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
    passwordTitle: "Contraseña",
    currentPassword: "Contraseña actual",
    currentPasswordRequired: "Escribe tu contraseña actual.",
    currentPasswordMismatch: "Esa no es tu contraseña actual.",
    changePassword: "Cambiar contraseña",
    changingPassword: "Cambiando…",
    passwordChanged: "Tu contraseña cambió. Cerramos tus demás sesiones.",
    forgotCurrent: "No recuerdo mi contraseña actual",
    // Con segundo factor la contraseña no se cambia desde la cuenta: se recupera por correo.
    passwordWithSecondFactor: "Tu cuenta tiene segundo factor. Para cambiar tu contraseña, recupérala desde tu correo.",
    recoverPassword: "Recuperar mi contraseña",
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
