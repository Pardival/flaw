/**
 * Erreurs RFC 9457. Le corps ne contient ni pile, ni SQL, ni chemin, ni nom de bibliothèque.
 */

export const PROBLEM_CODES = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "payload_too_large",
  "too_many_requests",
  "internal_error",
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export type ProblemStatus = 400 | 401 | 403 | 404 | 413 | 429 | 500;

export type ProblemBody = {
  type: "about:blank";
  status: ProblemStatus;
  title: string;
  code: ProblemCode;
  detail?: string;
};

const PROBLEMS: Record<ProblemStatus, { title: string; code: ProblemCode }> = {
  400: { title: "Requête invalide", code: "invalid_request" },
  401: { title: "Authentification requise", code: "unauthorized" },
  403: { title: "Accès refusé", code: "forbidden" },
  404: { title: "Introuvable", code: "not_found" },
  413: { title: "Charge trop volumineuse", code: "payload_too_large" },
  429: { title: "Trop de requêtes", code: "too_many_requests" },
  500: { title: "Erreur interne", code: "internal_error" },
};

export function problem(status: ProblemStatus, detail?: string): ProblemBody {
  const item = PROBLEMS[status];
  return {
    type: "about:blank",
    status,
    title: item.title,
    code: item.code,
    ...(detail === undefined ? {} : { detail }),
  };
}

type ProblemReply = {
  code: (status: number) => ProblemReply;
  header: (name: string, value: string) => ProblemReply;
  send: (body: ProblemBody) => unknown;
};

export function sendProblem(reply: ProblemReply, status: ProblemStatus, detail?: string): unknown {
  return reply
    .code(status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .header("cache-control", "no-store")
    .send(problem(status, detail));
}

/** Corps 403 de GET /me : schéma MfaRequired (type …/mfa_required, code mfa_required). */
export type MfaRequiredProblem = {
  type: "https://flaw.example.com/problems/mfa_required";
  status: 403;
  title: "Second facteur requis";
  code: "mfa_required";
};

export function mfaRequiredProblem(): MfaRequiredProblem {
  return {
    type: "https://flaw.example.com/problems/mfa_required",
    status: 403,
    title: "Second facteur requis",
    code: "mfa_required",
  };
}

type MfaReply = {
  code: (status: number) => MfaReply;
  header: (name: string, value: string) => MfaReply;
  send: (body: MfaRequiredProblem) => unknown;
};

export function sendMfaRequired(reply: MfaReply): unknown {
  return reply
    .code(403)
    .header("content-type", "application/problem+json; charset=utf-8")
    .header("cache-control", "no-store")
    .send(mfaRequiredProblem());
}
