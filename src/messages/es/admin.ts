import { defineMessages } from "../format";

// Los textos de administración que no son de la cuenta: hoy, la pantalla del equipo (diseño,
// PA-86). Van en su propio bloque para que no viajen al navegador con la pantalla de entrar.
//
// Tono (diseño, sección 8): de tú, frases cortas, con punto final, sin admiraciones. Una
// confirmación dice todo lo que va a pasar, no solo lo que se pidió: quitar una capacidad
// cierra sesiones, y restablecer un segundo factor deja a la persona fuera hasta que vuelva.
//
// Ningún plazo ni tope se escribe con su número: son parámetros, y la pantalla no los lee.
export const admin = defineMessages({
  // El bloque «Tu código», el mismo en cada sección que cambia algo con un código reciente.
  // Lo que dice su cuerpo es de cada sección.
  code: {
    title: "Tu código",
    submit: "Comprobar",
    submitting: "Comprobando…",
  },
  team: {
    title: "Equipo de administración",
    intro: "Quién entra a administración y con qué capacidades. Cada cambio queda registrado con tu nombre.",
    backToAdmin: "Ir al inicio de administración",
    working: "Guardando…",
    cancel: "Cancelar",
    unknown: "No supimos si el cambio se hizo. Revisa la lista antes de intentarlo otra vez.",
    invalid: "No pudimos hacerlo con esos datos. Revisa la lista e intenta de nuevo.",
    notConfigured: "Por ahora no se puede: falta un dato de configuración. Avisa a quien opera la base de datos.",
    listChanged: "La lista cambió mientras confirmabas. Revisa de nuevo lo que va a pasar.",
    // El código reciente venció entre pintar la pantalla y enviar.
    needsCode: "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio.",
    changesLocked: "Escribe tu código, al inicio de esta página, para poder hacer cambios.",

    // Dar el código otra vez, dentro de la pantalla (el bloque es el compartido, `admin.code`).
    codeBody: "Para cambiar el equipo hace falta un código reciente de tu aplicación de códigos. Mientras tanto puedes ver la lista.",
    codeNotAvailable: "Tu código es correcto, pero por ahora no se puede cambiar el equipo. Avisa a quien opera la base de datos.",

    // Invitar. No se manda ningún correo: quien invita le avisa a la persona.
    inviteTitle: "Invitar",
    inviteIntro: "La invitación no manda ningún correo: tú le avisas a la persona qué tiene que hacer.",
    inviteEmail: "Correo de la persona",
    inviteEmailRequired: "Escribe el correo de la persona.",
    inviteEmailInvalid: "Ese correo no tiene forma de correo. Revísalo.",
    inviteCapabilities: "Capacidades que recibirá",
    inviteCapabilitiesRequired: "Elige al menos una capacidad.",
    inviteSubmit: "Invitar",
    inviteSubmitting: "Invitando…",
    invitedNew:
      "Invitación creada para {email}. Todavía no tiene cuenta: dile que la cree con ese correo en la página de registro ({path}). Al terminar se le pedirá configurar su segundo factor.",
    invitedExisting:
      "Invitación creada para {email}. Ya tiene cuenta: dile que recupere su contraseña desde su correo ({path}), en el navegador con el que va a entrar a administración, y que después entre. Se le pedirá configurar su segundo factor.",
    alreadyInvited: "Ese correo ya tiene una invitación vigente. Está en la lista de invitaciones pendientes.",
    alreadyMember: "Esa cuenta ya es del equipo. Dale la capacidad en su fila, o restablece su segundo factor si no puede entrar.",
    inviteIneligible: "La cuenta de ese correo no está activa: no se le puede invitar.",

    // El equipo.
    membersTitle: "El equipo",
    self: "Tú",
    suspended: "Cuenta suspendida.",
    inactive: "Cuenta inactiva.",
    noEmail: "Cuenta sin correo",
    factorLost: "Su segundo factor ya no existe: no puede entrar a administración. Restablécelo.",
    rebindPending: "Sin segundo factor: tiene una invitación para configurarlo de nuevo.",
    rebindExpired: "Sin segundo factor, y su invitación para configurarlo caducó. Restablécelo otra vez.",
    rebindUnusable: "Sin segundo factor, y su invitación ya no se puede aceptar. Restablécelo otra vez.",
    rebindNone: "Sin segundo factor y sin invitación para configurarlo. Restablécelo.",
    give: "Dar {capability}",
    remove: "Quitar {capability}",
    // Lo que el botón dice además, para quien no ve la fila.
    toPerson: "a {email}",
    cannotGive: "Mientras no tenga su segundo factor no se le pueden dar capacidades.",
    configLocked: "No se le puede quitar {capability}: tienen que quedar otras dos cuentas activas con ella.",
    confirmRemoveTitle: "¿Quitar {capability} a {email}?",
    effectSessions: "Se cierran todas sus sesiones.",
    effectSelf: "Es tu propia cuenta: también se cierra tu sesión, y tendrás que entrar de nuevo.",
    effectLast: "Es su última capacidad: deja de ser del equipo. Se borran su segundo factor y las invitaciones dirigidas a esa cuenta.",
    effectInviter:
      "Se revocan las invitaciones vigentes que hizo. Si con una de ellas alguien iba a configurar de nuevo su segundo factor, habrá que restablecerlo otra vez.",
    effectLogged: "Queda registrado con tu nombre.",
    confirmRemove: "Sí, quitar",
    confirmGiveTitle: "¿Dar {capability} a {email}?",
    effectGiveConfig:
      "Podrá invitar, dar y quitar capacidades y restablecer segundos factores. Quitársela después cierra todas sus sesiones.",
    confirmGive: "Sí, dar",
    granted: "Capacidad dada.",
    revoked: "Capacidad quitada. Se cerraron las sesiones de esa cuenta.",
    alreadyHas: "Esa cuenta ya tenía esa capacidad.",
    notHeld: "Esa cuenta ya no tenía esa capacidad.",
    minConfig: "No se quitó: tienen que quedar otras dos cuentas activas con esa capacidad.",
    holds: "Tiene: {capabilities}.",
    grantNotMember: "Esa cuenta no tiene su segundo factor atado: no se le pueden dar capacidades.",
    grantIneligible: "Esa cuenta no está activa: no se le pueden dar capacidades.",

    // Invitaciones pendientes.
    invitationsTitle: "Invitaciones pendientes",
    noInvitations: "No hay invitaciones pendientes.",
    invitationGives: "Da: {capabilities}.",
    invitationRebind: "Para configurar de nuevo su segundo factor. No da capacidades.",
    invitedBy: "La hizo {email}.",
    invitedByOwner: "La puso quien opera la base de datos.",
    invitedByGone: "La hizo alguien que ya no está en el equipo.",
    expiresOn: "Caduca el {date}.",
    expired: "Caducó.",
    notAcceptable: "Ya no se puede aceptar: quien la hizo ya no puede invitar, o la cuenta invitada cambió. Revócala e invita de nuevo.",
    rebindNotAcceptable: "Ya no se puede aceptar. Restablece otra vez a esa persona, más abajo.",
    revoke: "Revocar",
    revokeDetail: "la invitación de {email}",
    reinvite: "Invitar de nuevo",
    reinviteDetail: "a {email}",
    confirmRevokeTitle: "¿Revocar la invitación de {email}?",
    effectRevokeGrant: "Ya no podrá aceptarla. Puedes invitar de nuevo después.",
    effectRevokeRebind: "Esa persona se queda sin con qué configurar su segundo factor: tendrás que restablecerlo otra vez.",
    confirmRevoke: "Sí, revocar",
    invitationRevoked: "Invitación revocada.",
    invitationGone: "Esa invitación ya no estaba vigente.",
    reinvited: "Invitación creada de nuevo. Avísale a la persona.",

    // Restablecer un segundo factor.
    resetTitle: "Restablecer un segundo factor",
    resetIntro:
      "Para quien perdió su aplicación de códigos. Tú le dictas un código, por teléfono o en persona, y con él configura un segundo factor nuevo.",
    resetNobody: "No hay nadie más en el equipo a quien restablecer.",
    resetChoose: "Restablecer",
    resetChooseDetail: "el segundo factor de {email}",
    confirmResetTitle: "¿Restablecer el segundo factor de {email}?",
    effectResetAlways:
      "Se borran su segundo factor y todas sus sesiones. Antes de volver a entrar, a cualquier parte del sitio, tendrá que recuperar su contraseña desde su correo.",
    effectResetInvitations: "Se revocan las invitaciones vigentes dirigidas a esa cuenta.",
    effectResetInviter:
      "Se revocan también las invitaciones vigentes que hizo. Si con una de ellas alguien iba a configurar de nuevo su segundo factor, habrá que restablecerlo otra vez.",
    effectResetAlone: "Es la única otra persona que puede cambiar el equipo: mientras no vuelva, quedarás como la única.",
    effectResetAgain: "Ya estaba restablecida: el código que le hayas dictado antes deja de servir.",
    effectResetCode:
      "Te mostraremos un código una sola vez. Su invitación para volver caduca en unos días, y se revoca si escribe mal el código varias veces.",
    confirmReset: "Sí, restablecer",
    resetting: "Restableciendo…",
    codeShownTitle: "Código para dictar",
    codeShownBody: "Díctaselo por teléfono o en persona, no por correo. Se muestra una sola vez: si se pierde, restablece de nuevo.",
    codeShownNext:
      "Dile que recupere su contraseña desde su correo ({path}), en el navegador con el que va a entrar, y que después entre. Ahí se le pedirá este código.",
    codeShownReload: "No recargues esta página: el código no se vuelve a mostrar.",
    codeDone: "Ya lo dicté",
    codeHidden: "El código ya no se muestra. Si no alcanzaste a dictarlo, restablece de nuevo.",
    backToList: "Volver a la lista",
    resetAlreadySent:
      "Ya restableciste a esta persona después de abrir esta confirmación. Revisa la lista: si no tienes el código que te mostramos, restablécela de nuevo.",
    resetSelf: "No puedes restablecer tu propio segundo factor. Pídeselo a otra persona con esa capacidad.",
    resetIneligible:
      "No se pudo restablecer: la cuenta no está activa, o su correo ya no es el que tenía al entrar al equipo. Eso lo arregla quien opera la base de datos.",
    resetNotMember: "Esa cuenta ya no es del equipo.",
    resetUnknown:
      "No supimos si se restableció. Revisa la lista: si la persona aparece sin segundo factor, restablece de nuevo, porque nadie conoce ese código.",
  },

  // PA-67, las prácticas y los niveles del catálogo. Las mismas frases para las dos listas,
  // salvo lo que nombra a la lista.
  catalog: {
    title: "Prácticas y niveles",
    intro: "Las listas con que se describe cada curso y se filtra el catálogo. Cada cambio queda registrado con tu nombre.",
    backToAdmin: "Ir al inicio de administración",
    working: "Guardando…",
    codeBody: "Para cambiar las prácticas o los niveles hace falta un código reciente de tu aplicación de códigos. Mientras tanto puedes ver las listas.",
    codeNotAvailable: "Tu código es correcto, pero por ahora no se pueden cambiar las listas. Avisa a quien opera la base de datos.",
    changesLocked: "Escribe tu código, al inicio de esta página, para poder hacer cambios.",

    practices: {
      title: "Prácticas",
      empty: "Todavía no hay prácticas.",
      addLabel: "Nombre de la práctica nueva",
      addSubmit: "Agregar práctica",
      duplicate: "Ya existe una práctica con ese nombre. Puede estar desactivada: búscala en la lista.",
      inactiveDuplicate: "«{name}» ya existe, desactivada. Puedes reactivarla: vuelve a su lugar en la lista.",
      inactive: "Desactivada",
      inUseRefused: "Ya la usa un curso, así que no se puede desactivar mientras tanto. La lista de ahora lo dice.",
      added: "Agregada: «{name}».",
      deactivated: "Desactivada. Ya no se ofrece al describir un curso ni al filtrar; puedes reactivarla.",
      reactivated: "Reactivada, en el lugar que tenía.",
    },
    levels: {
      title: "Niveles",
      empty: "Todavía no hay niveles.",
      addLabel: "Nombre del nivel nuevo",
      addSubmit: "Agregar nivel",
      duplicate: "Ya existe un nivel con ese nombre. Puede estar desactivado: búscalo en la lista.",
      inactiveDuplicate: "«{name}» ya existe, desactivado. Puedes reactivarlo: vuelve a su lugar en la lista.",
      inactive: "Desactivado",
      inUseRefused: "Ya lo usa un curso, así que no se puede desactivar mientras tanto. La lista de ahora lo dice.",
      added: "Agregado: «{name}».",
      deactivated: "Desactivado. Ya no se ofrece al describir un curso ni al filtrar; puedes reactivarlo.",
      reactivated: "Reactivado, en el lugar que tenía.",
    },

    // Los botones de cada fila. El nombre va oculto a la vista, para quien no ve la fila.
    up: "Subir",
    down: "Bajar",
    rename: "Renombrar",
    deactivate: "Desactivar",
    reactivate: "Reactivar",
    save: "Guardar",
    cancel: "Cancelar",
    // Lo que va oculto después de cada botón.
    of: "«{name}»",
    renameLabel: "Nombre nuevo de «{name}»",
    renameHint: "Su dirección en el catálogo no cambia: los enlaces guardados siguen sirviendo.",
    toneOf: "Tono de portada: {tone}",
    tones: {
      1: "arcilla",
      2: "ocre",
      3: "musgo",
      4: "pino",
      5: "laguna",
      6: "índigo",
      7: "ciruela",
      8: "vino",
    },

    // Lo que contestó el último envío.
    renamed: "Nombre guardado.",
    moved: "«{name}» quedó en el lugar {place} de {count}.",
    unchanged: "No había nada que cambiar.",
    // «En uso» (FL-58 E1): lo que usa un curso no se desactiva. Todavía no hay con qué
    // reasignar un curso: no se promete.
    inUse: { one: "En uso en {count} curso.", other: "En uso en {count} cursos." },
    listChanged: "La lista cambió mientras la veías. Esta es la de ahora: revisa y repite si hace falta.",
    needsCode: "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite el cambio.",
    unknown: "No supimos si el cambio se hizo. Revisa la lista antes de intentarlo otra vez.",

    // Los errores del nombre.
    nameRequired: "Escribe el nombre.",
    nameTooLong: "Usa como mucho {max} caracteres.",
    nameInvalid: "Usa al menos una letra o un número, sin caracteres especiales invisibles.",
  },
  // PA-61 y PA-62 en su versión mínima (T-108; decisiones de Sergio del 2026-10-14): la cola,
  // las lecciones de cada curso, el reproductor y aprobar, en una sola pantalla. Devolver al
  // maestro, las notas y la lista del revisor llegan con T-405.
  review: {
    title: "Cursos por revisar",
    intro: "Revisa cada lección y aprueba el curso cuando cumpla el estándar de producción. Aprobar lo publica: aparece en el catálogo.",
    backToAdmin: "Ir al inicio de administración",
    codeBody: "Para aprobar un curso hace falta un código reciente de tu aplicación de códigos. Mientras tanto puedes ver la cola y reproducir las lecciones.",
    codeNotAvailable: "Tu código es correcto, pero por ahora no se puede aprobar. Avisa a quien opera la base de datos.",
    approveLocked: "Escribe tu código, al inicio de esta página, para poder aprobar.",
    empty: "No hay cursos por revisar.",
    queueTitle: "La cola, agrupada: primero quien espera desde hace más",

    // De cada curso, bajo su maestro.
    practiceAndLevel: "Práctica: {practice}. Nivel: {level}.",
    unset: "sin definir",
    lessons: { one: "{count} lección, {duration} en total.", other: "{count} lecciones, {duration} en total." },
    loaded: "Cargado el {date}.",

    // De cada lección.
    watch: "Ver",
    watchOf: "«{title}»",
    videos: {
      test: "Sin video en Mux.",
      processing: "El video se está procesando. Puede tardar unos minutos.",
      errored: "El video no se pudo procesar.",
    },
    noScript: "Para reproducir una lección hace falta JavaScript. Aprobar funciona sin él.",

    // El reproductor, en su variante de revisión (diseño, sección 5).
    watching: "Viendo: {title}",
    watchingContext: "Del curso «{course}», de {teacher}.",
    // En la cola, junto a la lección que está en el reproductor (se esté viendo, cargando o
    // haya fallado: lo cierto en todos los casos es dónde está).
    watchingNow: "En el reproductor.",
    preview: "Vista previa. No genera puntos.",
    loading: "Preparando el video…",
    noVideo: "Esta lección no tiene video en Mux.",
    failed: "No se pudo cargar el video.",
    retry: "Reintentar",

    // Aprobar, en dos pasos dentro del curso.
    approve: "Aprobar y publicar",
    confirmTitle: "¿Aprobar y publicar este curso?",
    confirmBody: "Se publica y aparece en el catálogo.",
    confirmFirst: "Es el primer curso de {teacher}: su ficha también aparece en el catálogo.",
    confirm: "Sí, aprobar y publicar",
    cancel: "Cancelar",
    working: "Aprobando…",

    // Lo que contestó el último envío.
    approved: "Publicado. Ya aparece en el catálogo.",
    notPending: "Ese curso ya no está por revisar: alguien lo aprobó, o cambió. Esta es la cola de ahora.",
    incomplete: "A ese curso le falta su práctica o su nivel: no se puede publicar así.",
    practiceInactive: "La práctica de ese curso está desactivada. Reactívala en Prácticas y niveles para poder publicarlo.",
    levelInactive: "El nivel de ese curso está desactivado. Reactívalo en Prácticas y niveles para poder publicarlo.",
    videosNotReady: "Alguna lección de ese curso tiene un video que no está listo: todavía no se puede publicar.",
    needsCode: "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite.",
    unknown: "No supimos si el curso quedó publicado. Revisa la cola antes de intentarlo otra vez.",
  },
  // PA-68 mínima, las alertas de anomalía (T-208). Una alerta no es una acusación: la pantalla
  // dice «alerta» y «revisión», y «fraude» solo en el bloque donde se decide (diseño, PA-68).
  // Nadie aparece por su nombre: cada cuenta va con una huella de esa alerta.
  alerts: {
    title: "Alertas de anomalía",
    intro: "Revisa cada alerta y deja escrito qué concluiste. Una alerta no es una acusación: casi siempre tiene una explicación.",
    backToAdmin: "Ir al inicio de administración",
    codeBody: "Para revisar una alerta, decidir o excluir hace falta un código reciente de tu aplicación de códigos. Mientras tanto puedes ver las alertas.",
    codeNotAvailable: "Tu código es correcto, pero por ahora no se puede decidir sobre las alertas. Avisa a quien opera la base de datos.",
    changeLocked: "Escribe tu código, al inicio de esta página, para poder revisar y decidir.",
    listTitle: "Las alertas: primero las que esperan revisión",
    empty: "No hay alertas.",
    moreAlerts: { one: "Hay {count} alerta más que no cabe aquí.", other: "Hay {count} alertas más que no caben aquí." },

    // Cada alerta.
    kinds: {
      teacherPointsJump: "Subida de puntos de {un_maestro}",
      impossibleCompletion: "Más lecciones de las que caben",
      unconsumedPoolRatio: "Bote sin consumo",
    },
    period: "Periodo: {period}.",
    open: "Sin revisar",
    reviewed: "Revisada",
    triggers: {
      teacherPointsJump: "Sus puntos del mes subieron más que el umbral respecto al mes anterior.",
      impossibleCompletion: "Las lecciones que terminó esta cuenta piden más tiempo, a la velocidad máxima, del que pasó del periodo.",
      unconsumedPoolRatio: "El bote sin consumo pasó del umbral.",
    },
    teacher: "{Maestro}: {name}.",
    jumpPoints: "Medios puntos: {before} el mes anterior, {after} en este.",
    jumpRise: "Subida al detectarla: {metric}. Umbral: {threshold}.",
    jumpToday: "Subida hoy: {today}.",
    impossibleNeeded: "Necesitaba {metric} de video a la velocidad máxima, y habían pasado {threshold}.",
    impossibleToday: "Hoy necesitaría {today}.",
    detected: "Detectada el {date}.",
    hoursMinutes: "{hours} h {minutes} min",
    minutesOnly: "{minutes} min",

    // Las cuentas.
    accountsTitle: "Las cuentas que más le aportan",
    accountTitle: "La cuenta",
    account: "Cuenta {account}",
    columns: {
      account: "Cuenta",
      age: "Antigüedad",
      share: "Lo que le aporta",
      halfPoints: "Medios puntos este mes",
      before: "El mes anterior",
      lessons: "Lecciones",
      covered: "Tiempo visto",
      state: "Estado",
    },
    ages: { under7: "Menos de 7 días", under30: "Menos de 30 días", under90: "Menos de 90 días", over90: "Más de 90 días" },
    shares: { only: "Solo a este {maestro}", most: "La mayor parte", lessThanHalf: "Menos de la mitad" },
    finished: { one: "{count} lección terminada, {duration} vistos.", other: "{count} lecciones terminadas, {duration} vistos." },
    excluded: "Excluida",
    moreAccounts: { one: "Y {count} cuenta más.", other: "Y {count} cuentas más." },

    // La revisión.
    reviewTitle: "Revisión",
    noteLabel: "Nota de la revisión",
    noteHint: "Qué revisaste y qué concluiste. Se queda escrita.",
    markReviewed: "Marcar como revisada",
    reviewedBy: "Revisada el {date} por {name}.",
    someone: "alguien del equipo",
    note: "Nota: {note}",
    working: "Guardando…",

    // Decidir fraude: no se deshace.
    fraudTitle: "Decidir fraude",
    fraudBody: "Solo con la evidencia escrita. Decidirlo no se deshace.",
    evidenceLabel: "Evidencia",
    decideFraud: "Decidir que es fraude",
    confirmFraudTitle: "¿Decidir que esta alerta es fraude?",
    confirmFraudBody: "No se deshace. Después podrás excluir del reparto, por fraude, el consumo de las cuentas de esta alerta.",
    confirmFraud: "Sí, es fraude",
    fraudDecided: "Decidida como fraude.",
    evidence: "Evidencia: {evidence}",

    // Excluir del reparto, por cuenta.
    excludeTitle: "Excluir del reparto",
    exclude: "Excluir",
    confirmExcludeTitle: "¿Excluir del reparto la cuenta {account}?",
    confirmExcludeBody:
      "Sale todo su consumo de {period}, de todos {los_maestros}, desde la siguiente consolidación. Se puede revertir mientras el periodo siga abierto.",
    reasonCodeLabel: "Motivo",
    reasonPrompt: "Elige uno",
    reasons: { technicalError: "Error técnico", testAccount: "Cuenta de prueba", other: "Otro", fraud: "Fraude" },
    reasonLabel: "Por qué, escrito",
    confirmExclude: "Sí, excluir",
    cancel: "Cancelar",
    closed: "El periodo de esta alerta ya no recibe latidos: aquí no se excluye ni se revierte.",

    // Lo que ya se excluyó por esta alerta.
    exclusionsTitle: "Exclusiones de esta alerta",
    scopes: { account: "toda la cuenta", session: "una reproducción", interval: "un tramo de una lección" },
    exclusion: "Cuenta {account}, {scope}. {reason}: {text}. Por {name}, el {date}.",
    revokedBy: "Revertida el {date} por {name}: {text}.",
    revoke: "Revertir",
    confirmRevokeTitle: "¿Revertir esta exclusión?",
    confirmRevokeBody: "Su consumo vuelve a contar desde la siguiente consolidación, salvo si la cuenta está suspendida por fraude.",
    revokeReasonLabel: "Por qué se revierte",
    confirmRevoke: "Sí, revertir",

    // Lo que contestó el último envío.
    done: {
      alertReviewed: "Alerta revisada.",
      fraudDecided: "Alerta decidida como fraude.",
      accountExcluded: "Cuenta excluida. Sale del reparto desde la siguiente consolidación.",
      exclusionRevoked: "Exclusión revertida.",
    },
    written: "Lo que habías escrito: {text}",
    needsCode: "Tu código ya no es reciente. Escríbelo otra vez, al inicio de esta página, y repite.",
    missingNote: "Escribe la nota de la revisión.",
    missingEvidence: "Escribe la evidencia.",
    missingReason: "Elige el motivo y escribe por qué.",
    alreadyReviewed: "Esa alerta ya estaba revisada. Esta es la de ahora.",
    alreadyFraud: "Esa alerta ya estaba decidida como fraude.",
    alreadyExcluded: "Esa cuenta ya estaba excluida por ese motivo.",
    alreadyRevoked: "Esa exclusión ya estaba revertida.",
    closedNow: "El periodo de esa alerta ya no recibe latidos: no se excluye ni se revierte.",
    needsFraudDecision: "Para excluir por fraude, primero decide que la alerta es fraude.",
    notFound: "Esa alerta o esa cuenta ya no está. Estas son las de ahora.",
    unknown: "No supimos si tu decisión quedó guardada. Revisa la alerta antes de intentarlo otra vez.",
  },
});
