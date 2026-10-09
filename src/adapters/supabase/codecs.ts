import "server-only";

import { z } from "zod";

// Los enteros grandes (`bigint`, los centavos) llegan de `pg` como texto. Aquí se
// convierten, para que el dominio nunca reciba un número con decimales (TRD §8.10).
export const dbBigint = z
  .string()
  .regex(/^-?\d+$/)
  .transform((value) => BigInt(value));
