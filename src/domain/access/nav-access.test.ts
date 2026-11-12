import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  NO_NAV_ACCESS,
  TEACHER_NAV_STATES,
  TEAM_NAV_STATES,
  navAccessOf,
  opensAdmin,
  opensPortal,
  type TeacherNavState,
  type TeamNavState,
} from "./nav-access";

// Quién ve «Mi portal» y «Administración» en la barra (T-616, solicitud 2). Es una comodidad: quién
// entra lo decide la guarda de cada pantalla (04 §6.2), así que aquí solo se cuida no mostrarle un
// acceso a quien no tiene a dónde llegar.

describe("navAccessOf", () => {
  const ADMIN: Record<TeamNavState, boolean> = {
    none: false,
    // Con el código pendiente, el botón lo lleva a PA-12, y con el código, a administración.
    member: true,
    needs_code: true,
    // Sin factor atado: PA-12 le explica qué pasó.
    unbound: true,
    // Una invitación (también la de restablecer el factor) llega por su correo, no por la barra.
    invited: false,
    invited_unproven: false,
  };
  const PORTAL: Record<TeacherNavState, boolean> = {
    none: false,
    active: true,
    // El portal le pide el aviso, o le muestra lo suyo en solo lectura.
    needs_notice: true,
    suspended: true,
    invited: false,
    invited_unproven: false,
  };

  it("cada estado del equipo por cada estado del maestro da lo de la tabla", () => {
    for (const team of TEAM_NAV_STATES) {
      for (const teacher of TEACHER_NAV_STATES) {
        expect(navAccessOf(team, teacher), `${team} × ${teacher}`).toEqual({ admin: ADMIN[team], portal: PORTAL[teacher] });
      }
    }
  });

  it("las listas de estados son las que nombra la base, sin repetir", () => {
    expect([...TEAM_NAV_STATES].sort()).toEqual(Object.keys(ADMIN).sort());
    expect([...TEACHER_NAV_STATES].sort()).toEqual(Object.keys(PORTAL).sort());
  });

  it("lo que no se supo no abre nada, y no le quita al otro lo suyo", () => {
    expect(navAccessOf(null, null)).toEqual(NO_NAV_ACCESS);
    expect(navAccessOf(null, "active")).toEqual({ admin: false, portal: true });
    expect(navAccessOf("member", null)).toEqual({ admin: true, portal: false });
  });

  it("nunca abre nada a quien no es del equipo ni maestro, ni a una invitación, ni a lo que no se supo", () => {
    const team = fc.constantFrom<TeamNavState | null>(...TEAM_NAV_STATES, null);
    const teacher = fc.constantFrom<TeacherNavState | null>(...TEACHER_NAV_STATES, null);
    fc.assert(
      fc.property(team, teacher, (teamState, teacherState) => {
        const access = navAccessOf(teamState, teacherState);
        if (teamState === null || teamState === "none" || teamState.startsWith("invited")) expect(access.admin).toBe(false);
        if (teacherState === null || teacherState === "none" || teacherState.startsWith("invited")) expect(access.portal).toBe(false);
      }),
    );
  });

  it("los dos accesos salen de sus funciones, que se pueden preguntar por separado", () => {
    for (const team of TEAM_NAV_STATES) expect(opensAdmin(team)).toBe(ADMIN[team]);
    for (const teacher of TEACHER_NAV_STATES) expect(opensPortal(teacher)).toBe(PORTAL[teacher]);
    expect(opensAdmin(null)).toBe(false);
    expect(opensPortal(null)).toBe(false);
  });

  it("sin acceso es un valor que no se puede cambiar", () => {
    expect(NO_NAV_ACCESS).toEqual({ admin: false, portal: false });
    expect(Object.isFrozen(NO_NAV_ACCESS)).toBe(true);
  });
});
