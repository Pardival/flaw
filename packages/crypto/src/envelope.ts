import { ENC_VERSION, KEY_LENGTH, NONCE_LENGTH, assertKey, openXChaCha, randomBytes, sealXChaCha } from "./aead.ts";
import { concat, u32be, utf8 } from "./bytes.ts";
import { CryptoError } from "./errors.ts";

/**
 * Enveloppe KEK → DEK → contenu (A-013, SEC-DATA-05).
 *
 * Noms alignés sur T-005 : wrapped_ct, wrapped_nonce, key_id, enc_version.
 * key_id est l'identifiant de la KEK. status vaut active ou retired.
 *
 * AAD d'une colonne = id de la ligne ‖ nom de colonne.
 * AAD de la DEK = user_id ‖ key_id (identifiant de la KEK).
 *
 * Encodage de « ‖ » figé (arbitrage T-006) : le domaine, puis pour chaque
 * champ sa longueur en uint32 big-endian et ses octets UTF-8.
 * Un champ vide est refusé. enc_version 1 fige ce gabarit.
 */
const CONTENT_DOMAIN = utf8("flaw/aad/v1");
const DEK_DOMAIN = utf8("flaw/dek-aad/v1");

export const COLUMN = {
  projectionCt: "projection_ct",
  stateCt: "state_ct",
  updateCt: "update_ct",
  versionCt: "version_ct",
  labelCt: "label_ct",
} as const;

export type KeyStatus = "active" | "retired";

export type ContentBinding = {
  rowId: string;
  column: string;
};

export type Sealed = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyId: string;
  encVersion: number;
};

export type WrappedDek = {
  wrappedCt: Uint8Array;
  wrappedNonce: Uint8Array;
  keyId: string;
  encVersion: number;
  status: KeyStatus;
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
  return concat([CONTENT_DOMAIN, champ(binding.rowId), champ(binding.column)]);
}

export function dekAad(userId: string, keyId: string): Uint8Array {
  return concat([DEK_DOMAIN, champ(userId), champ(keyId)]);
}

export function generateDek(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

export function wrapDek(
  kek: Uint8Array,
  keyId: string,
  userId: string,
  dek: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH),
): WrappedDek {
  assertKey(kek);
  if (dek.length !== KEY_LENGTH) {
    throw new CryptoError("invalid_key_length");
  }
  return {
    wrappedCt: sealXChaCha(kek, nonce, dek, dekAad(userId, keyId)),
    wrappedNonce: nonce,
    keyId,
    encVersion: ENC_VERSION,
    status: "active",
  };
}

export function unwrapDek(kek: Uint8Array, userId: string, wrapped: WrappedDek): Uint8Array {
  assertKey(kek);
  if (wrapped.encVersion !== ENC_VERSION) {
    throw new CryptoError("unsupported_version");
  }
  return openXChaCha(kek, wrapped.wrappedNonce, wrapped.wrappedCt, dekAad(userId, wrapped.keyId));
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
