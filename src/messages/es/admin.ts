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

    // Dar el código otra vez, dentro de la pantalla.
    codeTitle: "Tu código",
    codeBody: "Para cambiar el equipo hace falta un código reciente de tu aplicación de códigos. Mientras tanto puedes ver la lista.",
    codeSubmit: "Comprobar",
    codeSubmitting: "Comprobando…",
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
    effectInviter: "Se revocan las invitaciones vigentes que hizo.",
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
    effectResetInviter: "Se revocan también las invitaciones vigentes que hizo.",
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
      "Ese restablecimiento ya se envió, o su confirmación caducó. Revisa la lista: si la persona aparece sin segundo factor y no tienes su código, restablece de nuevo.",
    resetSelf: "No puedes restablecer tu propio segundo factor. Pídeselo a otra persona con esa capacidad.",
    resetIneligible:
      "No se pudo restablecer: la cuenta no está activa, o su correo ya no es el que tenía al entrar al equipo. Eso lo arregla quien opera la base de datos.",
    resetNotMember: "Esa cuenta ya no es del equipo.",
    resetUnknown:
      "No supimos si se restableció. Revisa la lista: si la persona aparece sin segundo factor, restablece de nuevo, porque nadie conoce ese código.",
  },
});
