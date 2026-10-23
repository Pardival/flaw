/** Formulaire de connexion. Pas de onpaste, pas de traceur, pas de stockage navigateur. */
export const LOGIN_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Connexion</title>
</head>
<body>
<form method="post" action="/api/auth/sign-in">
<label>Identifiant <input name="identifier" autocomplete="username"></label>
<label>Mot de passe <input name="password" type="password" autocomplete="current-password"></label>
<button type="submit">Connexion</button>
<p>Mot de passe oublié ? L'administrateur fournit un mot de passe provisoire (commande serveur).</p>
</form>
</body>
</html>
`;

export const FORGOT_MESSAGE =
  "L'administrateur fournit un mot de passe provisoire (commande serveur).";

export const INVALID_LOGIN = "identifiant ou mot de passe incorrect";
export const TOO_MANY = "trop de tentatives";
export const AUTH_REQUIRED = "authentification requise";
export const ORIGIN_REJECTED = "origine refusée";
export const PASSWORD_REJECTED = "mot de passe refusé";
export const BAD_REQUEST = "requête invalide";
export const RESTRICTED = "session restreinte";
export const ENROLL_REFUSED = "enrôlement refusé";
export const MFA_REQUIRED = "code d'authentification requis";
