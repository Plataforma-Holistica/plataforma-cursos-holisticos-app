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
  // El recibo de un cobro (CO-03; T-303, decisión 8 de Sergio del 2026-11-06): mínimo. El desglose con el IVA es de T-306.
  receipt: {
    subject: "Recibimos tu pago",
    paid: "Recibimos tu pago de {amount} por tu plan {plan}, el {date}.",
    monthly: "mensual",
    annual: "anual",
    thanks: "Gracias por seguir aprendiendo con nosotros.",
    accountLabel: "Ver mi cuenta",
  },
});
