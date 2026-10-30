/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `desktop` : version de bureau 100 % locale (voir src/platform/target.ts). */
  readonly VITE_FLAW_TARGET?: string;
}
