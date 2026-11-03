// Lo que comparten quien arma un correo y quien lo manda (T-604). Los adaptadores no se importan entre sí, así que la forma vive aquí.

export interface OutgoingMail {
  /** Una por envío: el proveedor no manda dos veces lo mismo dentro de su ventana. */
  key: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * `sent`: salió. `retry`: no se supo, o puede salir después (nunca se trata como enviado). `rejected`: el proveedor dijo que este correo no va a salir nunca,
 * y reintentarlo no cambia nada.
 */
export type SendResult = "sent" | "retry" | "rejected";

export type MailSender = (mail: OutgoingMail) => Promise<SendResult>;
