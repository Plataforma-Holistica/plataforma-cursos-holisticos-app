import { parseDisplayName } from "./display-name";

// La guarda de sesión (RF-101, RF-108; TRD §9.2, fila «Lo que entra sin pasar por el
// formulario»; flujo de la app §6.2, pasos 2 a 4).
//
// Corre en toda entrada con sesión: en cada acción y en cada página, no solo en el paso
// previo. Existe porque una cuenta puede llegar a tener sesión sin haber pasado por el
// formulario: Auth acepta altas directas, y recuperar la contraseña confirma una cuenta
// que nunca completó su registro. El orden es fijo y se detiene en lo primero que falla.
//
// Lo que no hace: no sabe de roles (el maestro suspendido en solo lectura lo resuelve el
// portal, cuando exista), ni decide a qué pantalla se manda a nadie. Devuelve qué pasa y
// por qué; el servicio lo traduce:
//   - `blocked` con `suspended` → PA-35. Con `no_profile` o `deleted` → cerrar la sesión.
//   - `password_reset_required` → cerrar la sesión y mandar a recuperar (PA-13).
//   - `unavailable` → nadie entra, y es un fallo de operación que se reporta.
//   - `incomplete` → PA-15, que pide exactamente lo que dice `missing`. La propia ruta de
//     PA-15 trata `incomplete` como pase.

export interface DocumentFacts {
  /** Uno de los tipos de texto legal (`terms`, `student_privacy_notice`…). */
  docType: string;
  /** La versión vigente de ese tipo, o nulo si no hay ninguna que ya rija. */
  currentVersion: number | null;
  /**
   * La versión más alta, entre las que ya rigen, que pide volver a aceptar. Nulo si
   * ninguna lo pide. No basta mirar la vigente: si la 2 pedía volver a aceptar y la 3 no,
   * quien aceptó la 1 nunca aceptó el cambio de la 2.
   */
  reconsentFloor: number | null;
  /** El último consentimiento de la persona sobre cualquier versión de este tipo. */
  latest: { version: number; action: "granted" | "withdrawn" } | null;
}

export interface GateFacts {
  /** La fila de `profiles` de quien tiene la sesión, o nulo si no existe. */
  profile: {
    status: "active" | "suspended" | "deleted";
    passwordResetRequired: boolean;
    displayName: string | null;
    adultDeclaredAt: Date | null;
  } | null;
  /** Un elemento por cada tipo de texto obligatorio. Los de otros tipos se ignoran. */
  documents: readonly DocumentFacts[];
}

export interface MissingDocument {
  docType: string;
  /** Nunca lo aceptó; lo retiró; o hay una versión nueva que pide volver a aceptar. */
  why: "never_given" | "withdrawn" | "new_version";
}

export type GateResult =
  | { outcome: "blocked"; reason: "no_profile" | "suspended" | "deleted" }
  | { outcome: "password_reset_required" }
  | {
      outcome: "unavailable";
      // `no_current_text`: un tipo obligatorio no tiene texto vigente. Sin texto no hay
      // consentimiento válido. `facts_incomplete`: a la guarda le llegaron mal los hechos
      // (falta un tipo, viene repetido, o no se declaró ninguno): no adivina, no deja pasar.
      reason: "no_current_text" | "facts_incomplete";
      docTypes: string[];
    }
  | {
      outcome: "incomplete";
      /**
       * Cuál de las dos caras de PA-15. «Actualizamos nuestros textos» solo si todo lo que
       * falta es una versión nueva; si falta algo que nunca se dio, o algo que se retiró,
       * es «Completa tu cuenta», que pide todo junto.
       */
      variant: "complete_account" | "updated_texts";
      missing: { name: boolean; adultDeclaration: boolean; documents: MissingDocument[] };
    }
  | { outcome: "pass" };

function missingReason(document: DocumentFacts): MissingDocument["why"] | null {
  if (document.latest === null) return "never_given";
  if (document.latest.action === "withdrawn") return "withdrawn";
  if (document.reconsentFloor !== null && document.latest.version < document.reconsentFloor) return "new_version";
  return null;
}

/**
 * @param requiredDocTypes Los tipos de texto sin los que no se tiene cuenta completa. Van
 *   explícitos: si la guarda los sacara de `facts.documents`, una lista vacía sería un pase.
 */
export function resolveSessionGate(facts: GateFacts, requiredDocTypes: readonly string[]): GateResult {
  const { profile } = facts;
  if (profile === null) return { outcome: "blocked", reason: "no_profile" };
  if (profile.status !== "active") return { outcome: "blocked", reason: profile.status };
  if (profile.passwordResetRequired) return { outcome: "password_reset_required" };

  const required: DocumentFacts[] = [];
  const broken: string[] = [];
  for (const docType of requiredDocTypes) {
    const matches = facts.documents.filter((document) => document.docType === docType);
    const [only] = matches;
    if (matches.length !== 1 || only === undefined) broken.push(docType);
    else required.push(only);
  }
  if (requiredDocTypes.length === 0 || broken.length > 0) {
    return { outcome: "unavailable", reason: "facts_incomplete", docTypes: broken };
  }

  const withoutText = required.filter((document) => document.currentVersion === null);
  if (withoutText.length > 0) {
    return { outcome: "unavailable", reason: "no_current_text", docTypes: withoutText.map((document) => document.docType) };
  }

  const documents = required.flatMap((document) => {
    const why = missingReason(document);
    return why === null ? [] : [{ docType: document.docType, why }];
  });
  const name = !parseDisplayName(profile.displayName).ok;
  const adultDeclaration = profile.adultDeclaredAt === null;
  if (!name && !adultDeclaration && documents.length === 0) return { outcome: "pass" };

  const onlyNewVersions = !name && !adultDeclaration && documents.every((document) => document.why === "new_version");
  return {
    outcome: "incomplete",
    variant: onlyNewVersions ? "updated_texts" : "complete_account",
    missing: { name, adultDeclaration, documents },
  };
}
