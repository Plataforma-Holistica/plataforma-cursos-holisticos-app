import { defineMessages } from "../format";

// Los correos propios (T-604). Sin cifras escritas: cada plazo llega como dato.

export const mail = defineMessages({
  clabeNotice: {
    subject: "Se guardó una CLABE nueva en tu cuenta",
    intro: "Se guardó una CLABE nueva para tus pagos.",
    wait: "Empezaremos a pagarte en esa cuenta {hours} horas después de este correo, no antes.",
    yours: "Si fuiste tú, no tienes que hacer nada.",
    notYours: "Si no fuiste tú, cambia tu contraseña ahora: eso anula el cambio.",
    recoverLabel: "Cambiar mi contraseña",
    reviewLabel: "Ver mis datos fiscales",
  },
});
