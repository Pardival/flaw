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
