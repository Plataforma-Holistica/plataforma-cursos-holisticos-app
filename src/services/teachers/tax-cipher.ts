import "server-only";

import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, type KeyObject } from "node:crypto";

import { getEnv } from "@/config/env";

// El cifrado de los datos fiscales del maestro: RFC, razón social y CLABE (RF-510; 05 §10; TRD §9.7; T-409). AES-256-GCM en la
// aplicación: la base nunca tiene la llave, así que quien lea una copia de la base no lee el dato. Un solo archivo cifra y abre, y
// quién lo llama es una lista cerrada (`tests/architecture/tax-cipher.test.ts`).
//
// Lo guardado es `formato (1) | versión de la llave (2) | vector (12) | cifrado | etiqueta (16)`. GCM no cambia el largo, así que
// una CLABE cifrada mide exactamente 49 bytes, y la base lo exige: una CLABE en claro no entra.
//
// Los datos asociados atan cada columna a su maestro, a su campo, a la versión de su fila y a la versión de la llave: copiar una CLABE
// cifrada a otro maestro falla al abrirla. La de la CLABE ata además `clabe_last4`, que va en claro.
//
// Lo que entra se revisa antes de usarlo: un contexto sin forma haría ambiguos los datos asociados, y una CLABE que no termina en
// sus últimos cuatro haría que la pantalla dijera una cuenta y el pago fuera a otra. Eso no es una falla de la persona sino del
// código que llama, y lanza `TaxCipherMisuse`.
//
// Los errores tienen texto fijo y no encadenan el de Node: no pueden traer el dato. Nunca se prueba otra llave.
//
// Las llaves son `versión:base64:comprobación`, separadas por comas. La comprobación son los primeros 8 hexadecimales del SHA-256 de
// la llave: una mal pegada se detecta antes de cifrar con ella. Una rotación va en dos despliegues (manual de operación): primero se
// agrega la llave, y después se cambia la activa.

const ALGORITHM = "aes-256-gcm";
const FORMAT = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 3;
const KEY_LENGTH = 32;
/** Lo que cabe en las columnas `version` y `key_version`, un `smallint`, y en `env.ts`. */
const MAX_VERSION = 32_767;
const TEACHER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ENTRY = /^([1-9][0-9]{0,4}):([A-Za-z0-9+/]{43}=):([0-9a-f]{8})$/;

/** Lo cifrado. Solo este archivo lo emite: un texto cualquiera no pasa por aquí. */
export type SealedField = Buffer & { readonly __sealed: unique symbol };

export type TaxField = "rfc" | "legal_name" | "clabe";

/** De qué columna es un dato. `last4` solo en la CLABE: los últimos cuatro que van en claro. */
export type TaxFieldContext = { teacher: string; rowVersion: number } & ({ field: Exclude<TaxField, "clabe"> } | { field: "clabe"; last4: string });

/** No hay llave con que hacerlo. La aplicación sigue, y lo fiscal dice que no está disponible. */
export class TaxCipherUnavailable extends Error {
  constructor() {
    super("El cifrado de los datos fiscales no está disponible.");
    this.name = "TaxCipherUnavailable";
  }
}

/** Lo guardado no abre con su llave y su contexto: alguien lo cambió o lo copió. No es lo mismo que una falla, y se reporta aparte. */
export class TaxCipherTampered extends Error {
  constructor() {
    super("Un dato fiscal no se pudo abrir.");
    this.name = "TaxCipherTampered";
  }
}

/** El código que llama pasó algo sin forma. No se cifró ni se abrió nada. */
export class TaxCipherMisuse extends Error {
  constructor() {
    super("El cifrado de los datos fiscales recibió algo sin forma.");
    this.name = "TaxCipherMisuse";
  }
}

type KeySource = () => { keys: string | undefined; active: string | undefined };

interface Keys {
  byVersion: Map<number, KeyObject>;
  active: number;
}

/** Las llaves de la variable, o nulo si algo no cuadra: no se cifra con una llave dudosa. */
function loadKeys(keys: string | undefined, active: string | undefined): Keys | null {
  if (keys === undefined || active === undefined) return null;
  const byVersion = new Map<number, KeyObject>();
  for (const entry of keys.split(",")) {
    const match = KEY_ENTRY.exec(entry);
    if (match === null) return null;
    const version = Number(match[1]);
    const raw = Buffer.from(match[2] ?? "", "base64");
    if (version > MAX_VERSION || raw.length !== KEY_LENGTH || byVersion.has(version)) return null;
    if (createHash("sha256").update(raw).digest("hex").slice(0, 8) !== match[3]) return null;
    byVersion.set(version, createSecretKey(raw));
  }
  const activeVersion = Number(active);
  return byVersion.has(activeVersion) ? { byVersion, active: activeVersion } : null;
}

function assertContext(context: TaxFieldContext): void {
  const { teacher, rowVersion } = context;
  if (!TEACHER_ID.test(teacher) || !Number.isSafeInteger(rowVersion) || rowVersion < 1 || rowVersion > MAX_VERSION) throw new TaxCipherMisuse();
  if (context.field === "clabe" && !/^[0-9]{4}$/.test(context.last4)) throw new TaxCipherMisuse();
}

/** Los datos asociados. Canónicos porque `assertContext` ya revisó que ningún valor pueda traer el separador. */
function associatedData(context: TaxFieldContext, keyVersion: number): Buffer {
  const last4 = context.field === "clabe" ? context.last4 : "";
  return Buffer.from(["teacher_tax_profiles", context.teacher, context.field, String(context.rowVersion), String(keyVersion), last4].join("|"), "utf8");
}

/** @param source Solo las pruebas pasan otra. */
export function createTaxCipher(source: KeySource = () => ({ keys: getEnv().PII_ENCRYPTION_KEYS, active: getEnv().PII_ENCRYPTION_ACTIVE_VERSION })) {
  let loaded: Keys | null | undefined;
  const keys = (): Keys | null => {
    if (loaded === undefined) {
      const { keys: value, active } = source();
      loaded = loadKeys(value, active);
    }
    return loaded;
  };

  return {
    available: (): boolean => keys() !== null,

    /** La versión de la llave con que se cifra hoy. Va en la fila (`key_version`). */
    activeVersion(): number {
      const current = keys();
      if (current === null) throw new TaxCipherUnavailable();
      return current.active;
    },

    seal(context: TaxFieldContext, text: string): SealedField {
      assertContext(context);
      if (text === "") throw new TaxCipherMisuse();
      if (context.field === "clabe" && (!/^[0-9]{18}$/.test(text) || !text.endsWith(context.last4))) throw new TaxCipherMisuse();
      const current = keys();
      const key = current?.byVersion.get(current.active);
      if (current === null || key === undefined) throw new TaxCipherUnavailable();
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
      cipher.setAAD(associatedData(context, current.active));
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      const header = Buffer.alloc(HEADER_LENGTH);
      header.writeUInt8(FORMAT, 0);
      header.writeUInt16BE(current.active, 1);
      return Buffer.concat([header, iv, encrypted, cipher.getAuthTag()]) as SealedField;
    },

    /** Lanza si no abre: nunca devuelve otra cosa. Un texto sale solo si la etiqueta coincidió. */
    open(context: TaxFieldContext, sealed: Buffer): string {
      assertContext(context);
      const current = keys();
      if (current === null) throw new TaxCipherUnavailable();
      if (sealed.length < HEADER_LENGTH + IV_LENGTH + TAG_LENGTH || sealed.readUInt8(0) !== FORMAT) throw new TaxCipherTampered();
      const keyVersion = sealed.readUInt16BE(1);
      const key = current.byVersion.get(keyVersion);
      if (key === undefined) throw new TaxCipherUnavailable();
      const iv = sealed.subarray(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
      const tag = sealed.subarray(sealed.length - TAG_LENGTH);
      const encrypted = sealed.subarray(HEADER_LENGTH + IV_LENGTH, sealed.length - TAG_LENGTH);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
        decipher.setAAD(associatedData(context, keyVersion));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
      } catch {
        throw new TaxCipherTampered();
      }
    },
  };
}

export const taxCipher = createTaxCipher();
