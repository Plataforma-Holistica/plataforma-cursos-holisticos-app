import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { checkSession } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";
import { createInvoiceFiles } from "@/services/media/invoice-files";

import { askInvoiceBegin, askInvoiceCancel, askInvoiceFile, askInvoiceReview, askInvoiceSubmit, askInvoiceUnused, askInvoiceUpload } from "./invoice-records";
import { createInvoices, type InvoiceStore } from "./invoices";
import { taxCipher } from "./tax-cipher";
import { askTaxMine } from "./tax-records";

// El servicio de la factura del maestro, ya armado: lo que importarán las pantallas de la quinta solicitud (PA-47 y PA-82). Todo corre como el servidor, a
// nombre de la persona: la tabla no tiene ningún permiso para la aplicación, y a la base se entra por sus funciones.

export type { InvoiceBegin, InvoiceCancel, InvoiceFile, InvoiceReview, InvoiceSubmit } from "./invoices";

const store: InvoiceStore = {
  begin: (claims, payout, seen) => asServer({ claims, reason: "invoice_begin" }, (tx) => askInvoiceBegin(tx, payout, seen)),
  upload: (claims, invoice) => asServer({ claims, reason: "invoice_upload" }, (tx) => askInvoiceUpload(tx, invoice)),
  submit: (claims, seal) => asServer({ claims, reason: "invoice_submit" }, (tx) => askInvoiceSubmit(tx, seal)),
  cancel: (claims, invoice) => asServer({ claims, reason: "invoice_cancel" }, (tx) => askInvoiceCancel(tx, invoice)),
  review: (claims, invoice, decision) => asServer({ claims, reason: "invoice_review" }, (tx) => askInvoiceReview(tx, invoice, decision)),
  file: (claims, invoice, kind) => asServer({ claims, reason: "invoice_read" }, (tx) => askInvoiceFile(tx, invoice, kind)),
  unused: (claims, payout) => asServer({ claims, reason: "invoice_cleanup" }, (tx) => askInvoiceUnused(tx, payout)),
};

export const { beginInvoice, submitInvoice, cancelInvoice, reviewInvoice, invoiceFile } = createInvoices({
  store,
  files: createInvoiceFiles(),
  mine: (claims) => asServer({ claims, reason: "tax_profile_read" }, askTaxMine),
  cipher: taxCipher,
  checkSession,
  report: reportFailure,
});
