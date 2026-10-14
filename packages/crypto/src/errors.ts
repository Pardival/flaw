/** Erreur crypto : le message est un code, jamais une clé ni un clair. */
export class CryptoError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CryptoError";
    this.code = code;
  }
}
