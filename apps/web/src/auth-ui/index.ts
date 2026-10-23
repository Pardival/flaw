export { AuthScreens } from "./AuthScreens.tsx";
export type { AuthScreensProps } from "./AuthScreens.tsx";

export {
  AUTH_PATHS,
  CSRF_HEADER,
  CSRF_VALUE,
  authFetch,
  createAuthClient,
  csrfHeaders,
  failureKind,
  isMutating,
  normalizeIdentifier,
} from "./api.ts";
export type {
  AuthClient,
  AuthClientOptions,
  AuthFailure,
  AuthFetchInit,
  AuthResult,
  AuthSuccess,
  Credentials,
  FailureKind,
  FetchLike,
  MeProfile,
  PasswordChange,
} from "./api.ts";
