/**
 * Ressources i18next des écrans D-003, D-005, D-006 et D-007.
 * Français par défaut. v1 : la clé TOTP est en clair et le lien otpauth:// ouvre l'application.
 */
export const mfa = {
  loading: "Chargement…",
  pending: "Envoi…",
  challengeTitle: "Code d'authentification",
  challengeIntro: "Saisissez le code à 6 chiffres de votre application d'authentification.",
  totpLabel: "Code à 6 chiffres",
  submitCode: "Valider le code",
  useRecovery: "Utiliser un code de secours",
  recoveryTitle: "Code de secours",
  recoveryIntro: "Saisissez l'un des 10 codes fournis à l'activation.",
  recoveryLabel: "Code de secours",
  recoveryHint: "Format XXXX-XXXX-XXXX-XXXX.",
  submitRecovery: "Valider le code de secours",
  backToTotp: "Utiliser l'application d'authentification",
  codeFormat: "Saisissez un code au format attendu.",
  codeRejected: "Code refusé.",
  codeRequired: "Code d'authentification requis.",
  tooMany: "Trop de tentatives.",
  invalidRequest: "Requête invalide.",
  network: "Connexion au serveur impossible.",
  server: "Réponse du serveur inattendue.",
  enrollRefused: "Enrôlement refusé.",
  activationTitle: "Activer la double authentification",
  activationIntro:
    "Ajoutez cette clé dans votre application d'authentification, puis saisissez un code à 6 chiffres.",
  secretLabel: "Clé de configuration",
  openApp: "Ouvrir l'application",
  issuer: "Flaw",
  accountFallback: "compte",
  signOut: "Se déconnecter",
  signedOut: "Vous êtes déconnecté.",
  codesTitle: "Codes de secours",
  codesIntro:
    "Conservez ces 10 codes à usage unique. Chacun comporte 16 caractères, au format XXXX-XXXX-XXXX-XXXX.",
  copy: "Copier",
  save: "Enregistrer",
  print: "Imprimer",
  copied: "Codes copiés.",
  copyFailed: "Copie impossible.",
  continueTexts: "Accéder à mes textes",
  reconfigureTitle: "Reconfigurer la double authentification",
  reconfigureBody:
    "Cette connexion a utilisé un code de secours. Une nouvelle clé et 10 nouveaux codes vont remplacer les anciens, qui seront invalidés.",
  reconfigureNow: "Reconfigurer maintenant",
};
