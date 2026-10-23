import { describe, expect, it } from "vitest";

import type { MeProfile } from "./api.ts";
import {
  nextPreserve,
  phaseAfterRejectedSignIn,
  phaseForgot,
  phaseFromMe,
  showsLocalWork,
} from "./phase.ts";

const profile = (passwordMustChange: boolean): MeProfile => ({
  id: "user-1",
  email: "ada@exemple.fr",
  role: "user",
  locale: "fr",
  timeZone: "UTC",
  mfaEnrolled: false,
  passwordMustChange,
});

describe("phases d'authentification", () => {
  it("ouvre le changement imposé ou la session selon le profil", () => {
    expect(phaseFromMe({ ok: true, status: 200, data: profile(true) }, false).name).toBe("nouveau-mot-de-passe");
    expect(phaseFromMe({ ok: true, status: 200, data: profile(false) }, false)).toEqual({ name: "ready" });
  });

  it("affiche la connexion sans session et la reconnexion si le travail local existe", () => {
    expect(phaseFromMe({ ok: false, status: 401, kind: "unauthorized", retryAfter: null }, false)).toEqual({
      name: "connexion",
      notice: null,
    });
    expect(phaseFromMe({ ok: false, status: 401, kind: "unauthorized", retryAfter: null }, true)).toEqual({
      name: "reconnexion-necessaire",
      notice: null,
      forgot: false,
    });
  });

  it("bascule une erreur d'identifiants vers D-002 sans quitter D-042", () => {
    expect(phaseAfterRejectedSignIn("unauthorized", { name: "connexion", notice: null })).toEqual({
      name: "connexion-mdp-oublie",
      notice: "credential",
    });
    expect(
      phaseAfterRejectedSignIn("unauthorized", { name: "reconnexion-necessaire", notice: null, forgot: true }),
    ).toEqual({
      name: "reconnexion-necessaire",
      notice: "credential",
      forgot: true,
    });
  });

  it("garde l'explication du mot de passe oublié sur l'écran courant", () => {
    expect(phaseForgot({ name: "connexion", notice: "limited" })).toEqual({
      name: "connexion-mdp-oublie",
      notice: "limited",
    });
    expect(phaseForgot({ name: "reconnexion-necessaire", notice: null, forgot: false }).name).toBe(
      "reconnexion-necessaire",
    );
  });

  it("conserve le travail local pendant D-042 et un changement qui suit une session", () => {
    expect(showsLocalWork({ name: "connexion", notice: null }, false)).toBe(false);
    expect(showsLocalWork({ name: "reconnexion-necessaire", notice: null, forgot: false }, true)).toBe(true);
    expect(showsLocalWork({ name: "ready" }, false)).toBe(true);
    expect(nextPreserve({ name: "ready" }, false)).toBe(true);
    expect(nextPreserve({ name: "nouveau-mot-de-passe", notice: null }, true)).toBe(true);
    expect(showsLocalWork({ name: "nouveau-mot-de-passe", notice: null }, true)).toBe(true);
    expect(showsLocalWork({ name: "nouveau-mot-de-passe", notice: null }, false)).toBe(false);
    expect(nextPreserve({ name: "connexion", notice: null }, true)).toBe(false);
  });
});
