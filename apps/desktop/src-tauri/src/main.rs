// Pas de console sous Windows en version publiée.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flaw_desktop_lib::run()
}
