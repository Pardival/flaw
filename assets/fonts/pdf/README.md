# Polices du PDF (A-016)

Typst ne lit pas le woff2 des polices d'écran : le PDF utilise les **TTF statiques
officiels** (licence OFL, fichiers non modifiés, empreintes SHA-256 dans `SHA256SUMS`).
Noms attendus (voir `PDF_FONT_FILES` dans `packages/exporters/src/pdf/template.ts`) :

- EBGaramond-Regular.ttf, EBGaramond-Italic.ttf, EBGaramond-Bold.ttf, EBGaramond-BoldItalic.ttf
- CourierPrime-Regular.ttf, CourierPrime-Italic.ttf, CourierPrime-Bold.ttf, CourierPrime-BoldItalic.ttf
- SourceSerif4-Regular.ttf, SourceSerif4-Italic.ttf, SourceSerif4-Bold.ttf, SourceSerif4-BoldItalic.ttf (repli U+202F)
- Inter-…, LibreBaskerville-…, CrimsonPro-…, Literata-…, Lora-…, SourceSans3-…, IBMPlexSans-… (mêmes suffixes)

Sans ces fichiers, le PDF sur l'appareil n'est pas proposé : l'app bascule sur le
repli serveur (qui lit le même dossier), puis propose Word.

## Provenance (30/10/2026, fichiers non modifiés)

- Courier Prime : github.com/google/fonts, `ofl/courierprime/`
- EB Garamond : github.com/octaviopardo/EBGaramond12, `fonts/ttf/`
- Source Serif 4 : github.com/adobe-fonts/source-serif, branche `release`, `TTF/` (`-It` → `-Italic`, `-BoldIt` → `-BoldItalic`, renommage seul)
- Inter 4.1 : github.com/rsms/inter, version `v4.1`, `extras/ttf/`

Familles alternatives (Libre Baskerville, Crimson Pro, Literata, Lora, Source Sans 3, IBM Plex Sans) : non
fournies ; un texte dans l'une d'elles sort en Source Serif 4 dans le PDF.
