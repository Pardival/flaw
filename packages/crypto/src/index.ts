export { CryptoError } from "./errors.ts";
export {
  ENC_VERSION,
  KEY_LENGTH,
  NONCE_LENGTH,
  TAG_LENGTH,
  openXChaCha,
  randomBytes,
  sealXChaCha,
} from "./aead.ts";
export {
  DERIVED_KEY_LENGTH,
  HMAC_IDENTIFIERS_INFO_PREFIX,
  RECOVERY_CODES_INFO_PREFIX,
  deriveIdentifierHmacKey,
  deriveRecoveryCodeKey,
  hkdfSha256,
} from "./hkdf.ts";
export {
  CONTENT_TYPE,
  contentAad,
  dekAad,
  generateDek,
  openContent,
  sealContent,
  unwrapDek,
  wrapDek,
} from "./envelope.ts";
export type { ContentBinding, DekLookup, Sealed, WrappedDek } from "./envelope.ts";
