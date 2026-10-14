import { ENC_VERSION, KEY_LENGTH, NONCE_LENGTH, assertKey, openXChaCha, randomBytes, sealXChaCha } from "./aead.ts";
import { concat, u32be, utf8 } from "./bytes.ts";
import { CryptoError } from "./errors.ts";

/**
 * Enveloppe KEK → DEK → contenu (A-013, SEC-DATA-05). enc_version 1.
 *
 * Gabarit figé. « ‖ » encode chaque champ par sa longueur en uint32
 * big-endian puis ses octets UTF-8. Le domaine est une constante, sans
 * préfixe de longueur. Un champ vide ou un U+0000 est refusé.
 * owner_id, rowId et user_id sont des UUID canoniques en minuscules.
 *
 * AAD contenu = "flaw/aad/v1" ‖ owner_id ‖ rowId ‖ column
 * column est limitée à COLUMN. label_ct suit la même règle.
 *
 * AAD DEK = "flaw/dek-aad/v1" ‖ user_id ‖ kek_id ‖ u32be(enc_version)
 * Le dernier champ est le uint32 brut, pas une chaîne UTF-8.
 * Le domaine empêche toute coïncidence avec une AAD de contenu.
 *
 * user_keys.key_id est l'identifiant de la KEK.
 * Le key_id d'une ligne de contenu est l'id de la DEK (user_keys.id).
 */
const CONTENT_DOMAIN = utf8("flaw/aad/v1");
const DEK_DOMAIN = utf8("flaw/dek-aad/v1");
const UUID_CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const COLUMN = {
  projectionCt: "projection_ct",
  stateCt: "state_ct",
  updateCt: "update_ct",
  versionCt: "version_ct",
  labelCt: "label_ct",
  secretCt: "secret_ct",
} as const;

const COLUMN_VALUES = new Set<string>(Object.values(COLUMN));

export type ContentColumn = (typeof COLUMN)[keyof typeof COLUMN];
export type KeyStatus = "active" | "retired";

export type ContentBinding = {
  ownerId: string;
  rowId: string;
  column: ContentColumn;
};

export type Sealed = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  /** Id de la DEK (`user_keys.id`). */
  keyId: string;
  encVersion: number;
};

export type WrappedDek = {
  wrappedCt: Uint8Array;
  wrappedNonce: Uint8Array;
  /** Identifiant de la KEK (`user_keys.key_id`). */
  keyId: string;
  encVersion: number;
  status: KeyStatus;
};

/** keyId est l'id de la DEK. Le résultat est filtré par ownerId. */
export type DekLookup = (ownerId: string, keyId: string) => Uint8Array | undefined;

const OPEN_FAILURES = new Set([
  "authentication_failed",
  "unknown_key_id",
  "unsupported_version",
  "invalid_ciphertext",
  "invalid_nonce",
  "invalid_key_length",
  "invalid_binding",
]);

function assertUuid(value: string): void {
  if (!UUID_CANONICAL.test(value)) {
    throw new CryptoError("invalid_binding");
  }
}

function assertColumn(column: string): asserts column is ContentColumn {
  if (!COLUMN_VALUES.has(column)) {
    throw new CryptoError("invalid_binding");
  }
}

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

function decryptionFailed(error: unknown): never {
  if (error instanceof CryptoError && OPEN_FAILURES.has(error.code)) {
    throw new CryptoError("decryption_failed");
  }
  throw error;
}

export function contentAad(binding: ContentBinding): Uint8Array {
  assertUuid(binding.ownerId);
  assertUuid(binding.rowId);
  assertColumn(binding.column);
  return concat([CONTENT_DOMAIN, champ(binding.ownerId), champ(binding.rowId), champ(binding.column)]);
}

export function dekAad(userId: string, kekId: string, encVersion: number = ENC_VERSION): Uint8Array {
  assertUuid(userId);
  if (!Number.isInteger(encVersion) || encVersion < 0 || encVersion > 0xffffffff) {
    throw new CryptoError("invalid_binding");
  }
  return concat([DEK_DOMAIN, champ(userId), champ(kekId), u32be(encVersion)]);
}

export function generateDek(): Uint8Array {
  return randomBytes(KEY_LENGTH);
}

/** Nonce fourni : réservé aux vecteurs. Non exporté par l'index public. */
export function wrapDekWithNonce(
  kek: Uint8Array,
  kekId: string,
  userId: string,
  dek: Uint8Array,
  nonce: Uint8Array,
): WrappedDek {
  assertKey(kek);
  assertUuid(userId);
  if (dek.length !== KEY_LENGTH) {
    throw new CryptoError("invalid_key_length");
  }
  return {
    wrappedCt: sealXChaCha(kek, nonce, dek, dekAad(userId, kekId, ENC_VERSION)),
    wrappedNonce: nonce,
    keyId: kekId,
    encVersion: ENC_VERSION,
    status: "active",
  };
}

export function wrapDek(kek: Uint8Array, kekId: string, userId: string, dek: Uint8Array): WrappedDek {
  return wrapDekWithNonce(kek, kekId, userId, dek, randomBytes(NONCE_LENGTH));
}

export function unwrapDek(kek: Uint8Array, userId: string, wrapped: WrappedDek): Uint8Array {
  try {
    assertKey(kek);
    if (wrapped.encVersion !== ENC_VERSION) {
      throw new CryptoError("unsupported_version");
    }
    return openXChaCha(
      kek,
      wrapped.wrappedNonce,
      wrapped.wrappedCt,
      dekAad(userId, wrapped.keyId, wrapped.encVersion),
    );
  } catch (error) {
    decryptionFailed(error);
  }
}

/** Nonce fourni : réservé aux vecteurs. Non exporté par l'index public. */
export function sealContentWithNonce(
  dek: Uint8Array,
  keyId: string,
  binding: ContentBinding,
  plaintext: Uint8Array,
  nonce: Uint8Array,
): Sealed {
  assertUuid(keyId);
  return {
    ciphertext: sealXChaCha(dek, nonce, plaintext, contentAad(binding)),
    nonce,
    keyId,
    encVersion: ENC_VERSION,
  };
}

export function sealContent(
  dek: Uint8Array,
  keyId: string,
  binding: ContentBinding,
  plaintext: Uint8Array,
): Sealed {
  return sealContentWithNonce(dek, keyId, binding, plaintext, randomBytes(NONCE_LENGTH));
}

export function openContent(binding: ContentBinding, sealed: Sealed, resolveDek: DekLookup): Uint8Array {
  try {
    if (sealed.encVersion !== ENC_VERSION) {
      throw new CryptoError("unsupported_version");
    }
    assertUuid(sealed.keyId);
    const dek = resolveDek(binding.ownerId, sealed.keyId);
    if (dek === undefined) {
      throw new CryptoError("unknown_key_id");
    }
    return openXChaCha(dek, sealed.nonce, sealed.ciphertext, contentAad(binding));
  } catch (error) {
    decryptionFailed(error);
  }
}
