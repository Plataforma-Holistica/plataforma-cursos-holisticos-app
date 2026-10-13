import {
  AuthApiError,
  AuthRetryableFetchError,
  AuthSessionMissingError,
  AuthUnknownError,
  AuthWeakPasswordError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  alreadyClosed,
  enrollFailure,
  factorAlreadyGone,
  failureFromResponse,
  failureFromSdk,
  passwordSetFailure,
  provenPasswordFailure,
  provenPasswordLimited,
  recoveryForSecondFactor,
  recoveryNeedsAdministration,
  recoveryRequestFailure,
  redeemFailure,
  sessionLostOnRefresh,
  sessionRevoked,
  signInFailure,
  signUpFailure,
  unlistedRejection,
  verifyFailure,
  type AuthFailure,
} from "./auth-errors";

const rejected = (code: string | null, status = 400): AuthFailure => ({ kind: "rejected", status, code });
const unreachable: AuthFailure = { kind: "unreachable" };

// Lo que ninguna tabla reconoce: tiene que caer siempre en «no se supo».
const strangers: AuthFailure[] = [
  unreachable,
  rejected(null),
  rejected(null, 429),
  rejected("un_codigo_que_no_existe"),
  rejected("unexpected_failure"),
  rejected("conflict", 409),
  rejected("over_request_rate_limit", 429),
];

describe("leer un error del SDK", () => {
  it("un error de la API conserva su código y su estado, no su mensaje", () => {
    const failure = failureFromSdk(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"));
    expect(failure).toEqual({ kind: "rejected", status: 400, code: "invalid_credentials" });
    expect(JSON.stringify(failure)).not.toContain("Invalid login");
  });

  it.each([
    ["un corte de red", new AuthRetryableFetchError("fetch failed", 0)],
    ["un 503 de la pasarela", new AuthRetryableFetchError("Service Unavailable", 503)],
    ["lo que el SDK reintentaría, con el estado que sea", new AuthRetryableFetchError("Too Many", 429)],
    ["un error interno de Auth", new AuthApiError("boom", 500, "unexpected_failure")],
    ["un error que el SDK no entiende", new AuthUnknownError("?", new Error("?"))],
    ["algo que no es un error del SDK", new Error("otra cosa")],
    ["un valor que no es un error", "texto"],
    ["nada", undefined],
  ])("%s es «no hubo respuesta»", (_name, error) => {
    expect(failureFromSdk(error)).toEqual(unreachable);
  });

  it("una sesión que falta se reconoce aunque no traiga código", () => {
    expect(failureFromSdk(new AuthSessionMissingError())).toEqual(rejected("session_not_found"));
  });

  it("una contraseña débil se reconoce por su clase", () => {
    expect(failureFromSdk(new AuthWeakPasswordError("weak", 422, ["length"]))).toEqual(
      rejected("weak_password", 422),
    );
  });

  it("un error de la API sin código queda sin código", () => {
    expect(failureFromSdk(new AuthApiError("?", 403, undefined))).toEqual(rejected(null, 403));
  });
});

describe("leer la respuesta de una llamada directa", () => {
  it("toma el código cuando es un texto", () => {
    expect(failureFromResponse(400, { code: "refresh_token_not_found", message: "x" })).toEqual(
      rejected("refresh_token_not_found"),
    );
  });

  it.each([
    ["sin la cabecera de versión el código es un número", { code: 400, error_code: "session_not_found" }],
    ["un error con forma de OAuth", { error: "invalid_grant", error_description: "x" }],
    ["un cuerpo que no es un objeto", "<html>"],
    ["un cuerpo vacío", null],
  ])("%s: queda sin código", (_name, body) => {
    expect(failureFromResponse(400, body)).toEqual(rejected(null));
  });

  it.each([500, 502, 503, 504, 520])("un %i es «no hubo respuesta»", (status) => {
    expect(failureFromResponse(status, { code: "session_not_found" })).toEqual(unreachable);
  });
});

describe("registrar", () => {
  it.each([
    ["over_email_send_rate_limit", "mail_rate_limited"],
    ["signup_disabled", "signup_disabled"],
    ["email_provider_disabled", "signup_disabled"],
    ["validation_failed", "rejected"],
    ["email_address_invalid", "rejected"],
    ["user_already_exists", "existing_account"],
    ["email_exists", "existing_account"],
  ])("%s es %s", (code, expected) => {
    expect(signUpFailure(rejected(code))).toBe(expected);
  });

  it.each(strangers)("lo que no reconoce es «no se supo»: %j", (failure) => {
    expect(signUpFailure(failure)).toBe("unknown");
  });
});

describe("pedir la recuperación", () => {
  it("solo distingue el límite de correos", () => {
    expect(recoveryRequestFailure(rejected("over_email_send_rate_limit", 429))).toBe("mail_rate_limited");
  });

  it.each(strangers)("lo demás es «no se supo»: %j", (failure) => {
    expect(recoveryRequestFailure(failure)).toBe("unknown");
  });
});

describe("canjear un enlace", () => {
  it.each(["otp_expired", "validation_failed", "user_banned", "user_not_found"])(
    "%s: el enlace no sirve",
    (code) => {
      expect(redeemFailure(rejected(code, 403))).toBe("invalid_or_expired");
    },
  );

  it.each(strangers)("lo demás es «no se supo»: %j", (failure) => {
    expect(redeemFailure(failure)).toBe("unknown");
  });
});

describe("fijar una contraseña", () => {
  it.each([
    ["same_password", "same_password"],
    ["weak_password", "weak_password"],
    ["validation_failed", "rejected"],
    ["bad_jwt", "rejected"],
    ["session_not_found", "rejected"],
    ["session_expired", "rejected"],
    ["user_not_found", "rejected"],
    ["user_banned", "rejected"],
    ["reauthentication_needed", "rejected"],
    ["insufficient_aal", "rejected"],
  ])("%s es %s", (code, expected) => {
    expect(passwordSetFailure(rejected(code, 422))).toBe(expected);
  });

  it.each(strangers)("lo que no reconoce no es un éxito ni un rechazo: %j", (failure) => {
    expect(passwordSetFailure(failure)).toBe("unknown");
  });
});

describe("cambiar la contraseña con sesión, desde la cuenta", () => {
  it.each([
    ["same_password", "same_password"],
    ["weak_password", "weak_password"],
    ["session_not_found", "rejected"],
    ["reauthentication_needed", "rejected"],
  ])("%s es %s, como al fijarla desde un enlace", (code, expected) => {
    expect(provenPasswordFailure(rejected(code, 422))).toBe(expected);
  });

  // Aquí «no se supo» cierra todas las sesiones de la cuenta. El límite de peticiones se
  // contesta antes de tocar nada: se sabe que no se guardó.
  it("un límite de peticiones es un rechazo: no cambió nada", () => {
    expect(provenPasswordFailure(rejected("over_request_rate_limit", 429))).toBe("rejected");
    // Desde un enlace sigue siendo «no se supo»: ahí el enlace ya se gastó, y decide su tabla.
    expect(passwordSetFailure(rejected("over_request_rate_limit", 429))).toBe("unknown");
  });

  // Como rechazo conocido ya no deja el aviso de un código que ninguna lista conoce.
  it("ese límite deja su propio aviso en el registro, sin datos de nadie; lo demás, ninguno", () => {
    expect(provenPasswordLimited(rejected("over_request_rate_limit", 429))).toBe(
      "Auth rechazó set_password por su límite de peticiones: ningún cambio de contraseña desde la cuenta pasa mientras dure.",
    );
    for (const failure of [unreachable, rejected(null, 429), rejected("session_not_found", 403), rejected("same_password", 422)]) {
      expect(provenPasswordLimited(failure)).toBeNull();
    }
  });

  it.each(strangers.filter((failure) => !("code" in failure) || failure.code !== "over_request_rate_limit"))(
    "lo demás que no reconoce no es un éxito ni un rechazo: %j",
    (failure) => {
      expect(provenPasswordFailure(failure)).toBe("unknown");
    },
  );
});

describe("recuperar: cuándo se pasa al camino de administración", () => {
  it.each(["session_not_found", "same_password"])("con %s, sí", (code) => {
    expect(recoveryNeedsAdministration(rejected(code, 403))).toBe(true);
    expect(recoveryForSecondFactor(rejected(code, 403))).toBe(false);
  });

  // La cuenta tiene segundo factor y la sesión del canje es de primer nivel: Auth no deja
  // cambiar la contraseña con ella. Quien abrió el enlace sí controla el buzón, y con el
  // buzón se recupera la contraseña (decisión del 2026-10-12). Lo que el segundo factor
  // protege, entrar a administración, sigue pidiéndolo.
  it("con insufficient_aal, sí, y se sabe que fue por el segundo factor", () => {
    expect(recoveryNeedsAdministration(rejected("insufficient_aal", 401))).toBe(true);
    expect(recoveryForSecondFactor(rejected("insufficient_aal", 401))).toBe(true);
  });

  // Ni lo que es culpa de la contraseña o de la cuenta, ni lo que no se supo: por
  // administración se saltaría justo la revisión que falló.
  it.each([
    "weak_password",
    "validation_failed",
    "bad_jwt",
    "session_expired",
    "user_not_found",
    "user_banned",
    "reauthentication_needed",
    "over_request_rate_limit",
  ])("con %s, no", (code) => {
    expect(recoveryNeedsAdministration(rejected(code, 403))).toBe(false);
    expect(recoveryForSecondFactor(rejected(code, 403))).toBe(false);
  });

  it.each(strangers)("ni con lo que no se reconoce: %j", (failure) => {
    expect(recoveryNeedsAdministration(failure)).toBe(false);
  });
});

describe("entrar", () => {
  it.each([
    ["invalid_credentials", "invalid_credentials"],
    ["validation_failed", "invalid_credentials"],
    ["email_not_confirmed", "email_not_confirmed"],
    ["user_banned", "banned"],
    ["over_request_rate_limit", "rate_limited"],
  ])("%s es %s", (code, expected) => {
    expect(signInFailure(rejected(code))).toBe(expected);
  });

  it.each(strangers.filter((failure) => failure.kind !== "rejected" || failure.code !== "over_request_rate_limit"))(
    "lo que no reconoce es «no se supo»: %j",
    (failure) => {
      expect(signInFailure(failure)).toBe("unknown");
    },
  );
});

describe("el segundo factor: dar de alta", () => {
  it("a una cuenta que ya tiene un factor verificado se le pide segundo nivel, y eso se dice", () => {
    expect(enrollFailure(rejected("insufficient_aal", 400))).toBe("needs_second_level");
  });

  it.each([...strangers, rejected("too_many_enrolled_mfa_factors", 422), rejected("mfa_factor_name_conflict", 422)])(
    "lo demás es «no se supo»: %j",
    (failure) => {
      expect(enrollFailure(failure)).toBe("unknown");
    },
  );
});

describe("el segundo factor: verificar un código", () => {
  it.each([
    ["mfa_verification_failed", "wrong_code"],
    ["mfa_verification_rejected", "throttled"],
    ["mfa_factor_not_found", "factor_gone"],
    ["mfa_challenge_expired", "retry"],
    ["mfa_ip_address_mismatch", "retry"],
  ])("%s es %s", (code, expected) => {
    expect(verifyFailure(rejected(code))).toBe(expected);
  });

  // Con `throttled` se borra la cookie de sesión: ningún otro código puede caer ahí.
  it.each([...strangers, rejected("insufficient_aal"), rejected("session_not_found", 403), rejected("bad_jwt", 403)])(
    "lo que no reconoce es «no se supo», y no le cierra la sesión a nadie: %j",
    (failure) => {
      expect(verifyFailure(failure)).toBe("unknown");
    },
  );
});

describe("el segundo factor: quitar", () => {
  it("quitar uno que ya no existe es haberlo quitado", () => {
    expect(factorAlreadyGone(rejected("mfa_factor_not_found", 404))).toBe(true);
  });

  it.each([...strangers, rejected("insufficient_aal"), rejected("mfa_verification_failed")])("lo demás no: %j", (failure) => {
    expect(factorAlreadyGone(failure)).toBe(false);
  });
});

describe("renovar: cuándo la sesión se perdió de verdad", () => {
  it.each([
    "refresh_token_not_found",
    "refresh_token_already_used",
    "session_not_found",
    "session_expired",
    "user_not_found",
    "user_banned",
    "validation_failed",
  ])("%s: se perdió", (code) => {
    expect(sessionLostOnRefresh(rejected(code))).toBe(true);
  });

  it.each([...strangers, rejected("bad_jwt", 403), rejected("bad_json"), rejected("invalid_credentials")])(
    "un fallo pasajero o desconocido no borra la sesión: %j",
    (failure) => {
      expect(sessionLostOnRefresh(failure)).toBe(false);
    },
  );
});

describe("cerrar y preguntar por una sesión", () => {
  it.each(["session_not_found", "user_not_found"])("cerrar con %s es haber cerrado", (code) => {
    expect(alreadyClosed(rejected(code, 403))).toBe(true);
  });

  it.each([...strangers, rejected("bad_jwt", 403), rejected("user_banned", 403)])(
    "cerrar con otra cosa no es haber cerrado: %j",
    (failure) => {
      expect(alreadyClosed(failure)).toBe(false);
    },
  );

  it.each(["session_not_found", "user_not_found", "user_banned"])("%s: la sesión está revocada", (code) => {
    expect(sessionRevoked(rejected(code, 403))).toBe(true);
  });

  it.each([...strangers, rejected("bad_jwt", 403)])(
    "un token vencido o un fallo pasajero no dicen que esté revocada: %j",
    (failure) => {
      expect(sessionRevoked(failure)).toBe(false);
    },
  );
});

describe("el aviso de un rechazo que ninguna lista conoce", () => {
  it("dice la operación, el estado y el código", () => {
    expect(unlistedRejection("sign_in", rejected("un_codigo_nuevo", 422))).toBe(
      "Auth rechazó sign_in con un código que no está en su lista: estado 422, código un_codigo_nuevo.",
    );
  });

  it("sin respuesta de Auth no hay aviso: no hubo rechazo", () => {
    expect(unlistedRejection("sign_in", unreachable)).toBeNull();
  });

  it.each([
    ["sin código", null],
    ["vacío", ""],
    ["con espacios, como un mensaje", "Invalid login credentials"],
    ["con un correo", "ana@ejemplo.mx"],
    ["con mayúsculas", "Bad_Jwt"],
    ["con salto de línea", "bad_jwt\notra línea"],
    ["más largo que un código", "a".repeat(65)],
  ])("un código %s no se escribe: sale `sin_codigo`", (_caso, code) => {
    expect(unlistedRejection("redeem", rejected(code, 400))).toBe(
      "Auth rechazó redeem con un código que no está en su lista: estado 400, código sin_codigo.",
    );
  });

  it("un código de 64 caracteres sí cabe", () => {
    expect(unlistedRejection("sign_up", rejected("a".repeat(64), 400))).toContain(`código ${"a".repeat(64)}.`);
  });

  it.each([Number.NaN, 400.5, Number.POSITIVE_INFINITY, -1, 1000])("un estado que no es de HTTP sale como 0: %s", (status) => {
    expect(unlistedRejection("set_password", rejected("un_codigo_nuevo", status))).toContain("estado 0,");
  });
});
