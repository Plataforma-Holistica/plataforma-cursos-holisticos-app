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
  // El aviso a finanzas (CO-22; T-303, tercera solicitud): a lo más uno por hora, con cuántos y el primero (decisión 3 de Sergio del 2026-11-07). Sin la cuenta ni montos.
  billingAlert: {
    subject: "Un aviso de cobro no se procesó",
    failed: {
      one: "{count} aviso de cobro no se pudo procesar. Llegó el {date} a las {time}, y es: {type}.",
      other: "{count} avisos de cobro no se pudieron procesar. El primero llegó el {date} a las {time}, y es: {type}.",
    },
    action: "Revisa la cola: reintenta cada uno o resuélvelo a mano con una nota.",
    linkLabel: "Ver los avisos",
  },
});
