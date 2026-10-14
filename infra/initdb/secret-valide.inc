# SEC-SECRET-07 — validateur unique, sourcé par creer-secrets.sh et par
# 01-role-applicatif.sh. Déposé dans initdb/ : le montage postgres le rend
# disponible à l'init, et l'entrypoint ignore ce fichier (ni .sh, ni .sql).
# Retire un seul \r\n ou \n final. Longueur et caractères distincts : octets.
# LC_ALL=C : gawk compte sinon des caractères, pas des octets UTF-8.

_secret_awk() {
  printf '%s' "$1" | LC_ALL=C awk -v mode="$2" '
BEGIN { RS = "\0"; got = 0 }
{
  got = 1
  s = $0
  n = length(s)
  if (n >= 2 && substr(s, n - 1, 1) == "\r" && substr(s, n, 1) == "\n") {
    s = substr(s, 1, n - 2)
  } else if (n >= 1 && substr(s, n, 1) == "\n") {
    s = substr(s, 1, n - 1)
  }
  if (mode == "norm") {
    printf "%s", s
    exit 0
  }
  if (index(s, "\r") || index(s, "\n")) exit 1
  if (length(s) < 32) exit 1
  seen_count = 0
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (!(c in seen)) {
      seen[c] = 1
      seen_count++
    }
  }
  if (seen_count < 16) exit 1
  low = tolower(s)
  words = "change example exemple password motdepasse secret default todo xxx test dummy sample flaw postgres admin restic"
  nwords = split(words, w, " ")
  for (i = 1; i <= nwords; i++) if (index(low, w[i])) exit 1
  exit 0
}
END { if (!got) exit 1 }
'
}

secret_valide() {
  _secret_awk "$1" check >/dev/null
}

secret_normalise() {
  _secret_awk "$1" norm
}
