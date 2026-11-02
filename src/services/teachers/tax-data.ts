import "server-only";

import { asServer } from "@/adapters/supabase/db";
import { checkSession, confirmPassword } from "@/services/account/account";
import { reportFailure } from "@/services/error-reporting/server";

import { readTeacherStanding } from "./records";
import { taxCipher } from "./tax-cipher";
import { createTaxProfile, type TaxStore } from "./tax-profile";
import { askTaxForPayout, askTaxMine, askTaxSave, askTaxState } from "./tax-records";

// El servicio de los datos fiscales, ya armado: lo que importan las pantallas. Todo corre como el servidor, a nombre de la persona: la tabla no tiene ningún
// permiso para la aplicación, y a la base se entra por sus cuatro funciones. Cada una confirma su transacción antes de que aquí se abra nada.

export type { MaskedTaxProfile, OpenTaxProfile, TaxPayoutRead, TaxReveal, TaxSave } from "./tax-profile";

const store: TaxStore = {
  state: (claims) => asServer({ claims, reason: "tax_profile_state" }, askTaxState),
  mine: (claims) => asServer({ claims, reason: "tax_profile_read" }, askTaxMine),
  save: (claims, row) => asServer({ claims, reason: "tax_profile_save" }, (tx) => askTaxSave(tx, row)),
  forPayout: (claims, payout) => asServer({ claims, reason: "tax_profile_read_for_payout" }, (tx) => askTaxForPayout(tx, payout)),
};

export const { taxDataReady, taxProfileState, revealTaxProfile, saveTaxProfile, taxProfileForPayout } = createTaxProfile({
  store,
  cipher: taxCipher,
  confirmPassword,
  standing: (claims) => asServer({ claims, reason: "teacher_standing" }, (tx) => readTeacherStanding(tx, null)),
  checkSession,
  report: reportFailure,
});
