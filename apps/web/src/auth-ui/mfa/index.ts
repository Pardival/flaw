export { MfaScreens } from "./MfaScreens.tsx";
export type { MfaIntent, MfaScreensProps } from "./MfaScreens.tsx";

export {
  dropEnrollment,
  enrollmentAccount,
  enrollFresh,
  enrollOnce,
  MFA_PATHS,
  signOutOfEnrollment,
  submitRecoveryCode,
  submitTotpCode,
  verifyEnrollmentCode,
} from "./flow.ts";
export type { EnrollmentOutcome, FactorOutcome } from "./flow.ts";

export { messages } from "./messages.fr.ts";

export {
  activationPhase,
  challengePhase,
  codesPhase,
  noticeFromKind,
  phaseAfterSignOut,
  reconfigurePhase,
  recoveryPhase,
  showsTexts,
} from "./phase.ts";
export type { EnrollmentBundle, MfaNotice, MfaPhase } from "./phase.ts";

export { BACKUP_FILENAME, RECOVERY_CODE_COUNT, backupText, formatRecoveryCode, formatTotp, groupSecret, otpauthUri } from "./policy.ts";
