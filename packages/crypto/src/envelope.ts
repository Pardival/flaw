import { ENC_VERSION, KEY_LENGTH, NONCE_LENGTH, assertKey, openXChaCha, randomBytes, sealXChaCha } from "./aead.ts";
import { concat, u32be, utf8 } from "./bytes.ts";
import { CryptoError } from "./errors.ts";

/**
 * Enveloppe KEK → DEK → contenu (A-013, SEC-DATA-05).
 *
 * AAD contenu = identifiant du texte ‖ owner_id ‖ type (paquet et A-013).
 * AAD de la DEK = user_id ‖ kek_id (SEC-DATA-05).
 *
 * Encodage provisoire de « ‖ », figé par enc_version = 1 : le paquet n'a pas
 * de gabarit d'octets. Domaine ASCII, octet 0, puis chaque champ en
 * uint32 grand-boutien + UTF-8. Un champ vide est refusé.
 *
 * Noms du paquet : dek_ct, dek_nonce, kek_id. Le schéma T-005 fusionné nomme
 * wrapped_ct, wrapped_nonce, key_id et n'a pas de colonne status.
 * L'API conserve les deux identifiants (kekId et la clé de contenu).
 * status : valeurs non spécifiées, champ absent (BLOCKER).
 */
const CONTENT_DOMAIN = utf8("flaw/aad/v1");
const DEK_DOMAIN = utf8("flaw/dek-aad/v1");
const SEPARATOR = Uint8Array.of(0);

export const CONTENT_TYPE = {
  projection: "projection",
  state: "state",
  update: "update",
  version: "version",
  label: "label",
  totp: "totp",
  audit: "audit",
} as const;

export type ContentBinding = {
  textId: string;
  ownerId: string;
  type: string;
};

export type Sealed = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyId: string;
  encVersion: number;
};

export type WrappedDek = {
  dekCt: Uint8Array;
  dekNonce: Uint8Array;
  kekId: string;
  encVersion: number;
};

export type DekLookup = (keyId: string) => Uint8Array | undefined;

function champ(value: string): Uint8Array {
  if (value.length === 0 || value.includes("\0")) {
    throw new CryptoError("invalid_binding");
  }
  const bytes = utf8(value);
  if (bytes.length > 0xffffffff) {
    throw new CryptoError("invalid_binding");
  }
  return concat([u32be(bytes.length), bytes]);
}

export function contentAad(binding: ContentBinding): Uint8Array {
  return concat([
    CONTENT_DOMAIN,
    SEPARATOR,
    champ(binding.textId),
    champ(binding.ownerId),
    champ(binding.type),
  ]);
}

export function dekAad(userId: string, kekId: string): Uint8Array {
  return concat([DEK_DOMAIN, SEPARATOR, champ(userId), champ(kekId)]);
}

export function generateDek(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

export function wrapDek(
  kek: Uint8Array,
  kekId: string,
  userId: string,
  dek: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH),
): WrappedDek {
  assertKey(kek);
  if (dek.length !== KEY_LENGTH) {
    throw new CryptoError("invalid_key_length");
  }
  return {
    dekCt: sealXChaCha(kek, nonce, dek, dekAad(userId, kekId)),
    dekNonce: nonce,
    kekId,
    encVersion: ENC_VERSION,
  };
}

export function unwrapDek(
  kek: Uint8Array,
  userId: string,
  wrapped: WrappedDek,
): Uint8Array {
  assertKey(kek);
  if (wrapped.encVersion !== ENC_VERSION) {
    throw new CryptoError("unsupported_version");
  }
  return openXChaCha(kek, wrapped.dekNonce, wrapped.dekCt, dekAad(userId, wrapped.kekId));
}

export function sealContent(
  dek: Uint8Array,
  keyId: string,
  binding: ContentBinding,
  plaintext: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH),
): Sealed {
  if (keyId.length === 0) {
    throw new CryptoError("invalid_binding");
  }
  return {
    ciphertext: sealXChaCha(dek, nonce, plaintext, contentAad(binding)),
    nonce,
    keyId,
    encVersion: ENC_VERSION,
  };
}

export function openContent(
  binding: ContentBinding,
  sealed: Sealed,
  resolveDek: DekLookup,
): Uint8Array {
  if (sealed.encVersion !== ENC_VERSION) {
    throw new CryptoError("unsupported_version");
  }
  const dek = resolveDek(sealed.keyId);
  if (dek === undefined) {
    throw new CryptoError("unknown_key_id");
  }
  return openXChaCha(dek, sealed.nonce, sealed.ciphertext, contentAad(binding));
}
