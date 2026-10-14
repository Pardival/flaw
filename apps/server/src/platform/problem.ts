/**
 * Erreurs RFC 9457. Le corps ne contient ni pile, ni SQL, ni chemin, ni nom de bibliothèque.
 */

export const PROBLEM_CODES = [
  "invalid_request",
  "not_found",
  "payload_too_large",
  "internal_error",
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export type ProblemStatus = 400 | 404 | 413 | 500;

export type ProblemBody = {
  type: "about:blank";
  status: ProblemStatus;
  title: string;
  code: ProblemCode;
};

const PROBLEMS: Record<ProblemStatus, { title: string; code: ProblemCode }> = {
  400: { title: "Requête invalide", code: "invalid_request" },
  404: { title: "Introuvable", code: "not_found" },
  413: { title: "Charge trop volumineuse", code: "payload_too_large" },
  500: { title: "Erreur interne", code: "internal_error" },
};

export function problem(status: ProblemStatus): ProblemBody {
  const item = PROBLEMS[status];
  return {
    type: "about:blank",
    status,
    title: item.title,
    code: item.code,
  };
}

type ProblemReply = {
  code: (status: number) => ProblemReply;
  header: (name: string, value: string) => ProblemReply;
  send: (body: ProblemBody) => unknown;
};

export function sendProblem(reply: ProblemReply, status: ProblemStatus): unknown {
  return reply
    .code(status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .header("cache-control", "no-store")
    .send(problem(status));
}
