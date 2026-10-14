import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  SECURITY_EVENTS,
  hashSession,
  redact,
  securityRecord,
  summarizeUserAgent,
  writeSecurityLog,
} from "./security-log.ts";

const PHRASE = "PHRASEMARQUEURINÉDITE";
const PASSWORD = "MOTDEPASSEMARQUEUR9f3a";

describe("SEC-LOG-01", () => {
  it("écrit chaque événement avec l'horodatage, le type, l'utilisateur, la session hachée, l'IP, l'agent et le résultat", () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const session = "session-brute-ne-doit-pas-apparaitre";
    for (const type of SECURITY_EVENTS) {
      const stream = new PassThrough();
      let text = "";
      stream.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      writeSecurityLog(
        stream,
        {
          type,
          userId: "user-7",
          sessionId: session,
          ip: "203.0.113.9",
          userAgent: "Mozilla/5.0",
          result: type === "login_success" ? "succes" : "echec",
        },
        now,
      );
      const record = JSON.parse(text) as Record<string, unknown>;
      expect(record).toEqual({
        ts: "2026-10-14T12:00:00.000Z",
        type,
        user_id: "user-7",
        session_id: hashSession(session),
        ip: "203.0.113.9",
        user_agent: "Mozilla/5.0",
        result: type === "login_success" ? "succes" : "echec",
      });
      expect(text).not.toContain(session);
      expect(record.session_id).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe("SEC-LOG-02", () => {
  it("retire le titre, le contenu, le mot de passe, les jetons et les cookies", () => {
    const poisoned = {
      ts: "2026-10-14T12:00:00.000Z",
      type: "login_failure",
      user_id: null,
      session_id: null,
      ip: "203.0.113.9",
      user_agent: summarizeUserAgent(`Nav ${PHRASE}`),
      result: "echec",
      password: PASSWORD,
      title: PHRASE,
      content: PHRASE,
      body: { title: PHRASE, sync: PHRASE },
      authorization: `Bearer ${PASSWORD}`,
      cookie: PASSWORD,
      token: PASSWORD,
      totp: PASSWORD,
      reset: PASSWORD,
    };
    const safe = redact(poisoned);
    const text = JSON.stringify(safe);
    expect(text).not.toContain(PHRASE);
    expect(text).not.toContain(PASSWORD);
    expect(safe).toMatchObject({ type: "login_failure", result: "echec" });
  });

  it("ne laisse pas un mot de passe ni un titre dans l'enregistrement de sécurité", () => {
    const stream = new PassThrough();
    let text = "";
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    const record = securityRecord({
      type: "login_failure",
      result: "echec",
      userAgent: `Nav ${PASSWORD} ${PHRASE}`,
      sessionId: PASSWORD,
    });
    stream.write(`${JSON.stringify(record)}\n`);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(PHRASE);
    expect(summarizeUserAgent(`Nav ${PASSWORD} ${PHRASE}`)).toBe("Nav");
  });
});
