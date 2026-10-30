//! Coquille de bureau de Flaw.
//!
//! Toute l'application est l'interface web construite en mode `desktop`
//! (aucun serveur, IndexedDB comme seule source). La page n'a accès qu'à une
//! commande : enregistrer un fichier choisi par la personne dans la fenêtre
//! native « Enregistrer sous ». Aucun accès libre au disque ni au réseau.

use percent_encoding::percent_decode_str;
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_dialog::DialogExt;

/// Taille maximale d'un fichier enregistré (export, sauvegarde) : 1 Gio.
const MAX_FILE_BYTES: usize = 1 << 30;

/// Garde un nom de fichier simple : pas de chemin, pas de caractère réservé.
fn safe_file_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = name.trim().trim_start_matches('.').to_string();
    if trimmed.is_empty() {
        "texte".to_string()
    } else {
        trimmed.chars().take(180).collect()
    }
}

/// Corps brut = contenu du fichier ; en-tête `x-flaw-name` = nom proposé.
/// Renvoie `true` si le fichier est écrit, `false` si la personne annule.
#[tauri::command]
async fn save_file(app: tauri::AppHandle, request: Request<'_>) -> Result<bool, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("corps attendu en binaire".into());
    };
    if bytes.len() > MAX_FILE_BYTES {
        return Err("fichier trop volumineux".into());
    }
    let proposed = request
        .headers()
        .get("x-flaw-name")
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_decode_str(value).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    let name = safe_file_name(&proposed);

    let mut dialog = app.dialog().file().set_file_name(&name);
    if let Some(extension) = std::path::Path::new(&name).extension().and_then(|e| e.to_str()) {
        dialog = dialog.add_filter(extension.to_uppercase(), &[extension]);
    }
    let Some(target) = dialog.blocking_save_file() else {
        return Ok(false);
    };
    let path = target.into_path().map_err(|_| "chemin invalide".to_string())?;
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_file])
        .run(tauri::generate_context!())
        .expect("impossible de démarrer Flaw");
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

    #[test]
    fn nom_sans_chemin_ni_caractere_reserve() {
        assert_eq!(safe_file_name("../../etc/passwd"), "-..-etc-passwd");
        assert_eq!(safe_file_name("Mon roman.pdf"), "Mon roman.pdf");
        assert_eq!(safe_file_name("a:b*c?.docx"), "a-b-c-.docx");
        assert_eq!(safe_file_name("   "), "texte");
        assert_eq!(safe_file_name(".cache"), "cache");
    }
}
