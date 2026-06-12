mod desktop;
mod wallpaper;

use desktop::{AppWindowRect, DesktopActionResult, DesktopSession, DesktopSessionInfo};
use std::sync::{Mutex, OnceLock};
use tauri::{Manager, WindowEvent};
use wallpaper::{WallpaperClick, WallpaperInputState, WallpaperMetrics};

static DESKTOP_SESSION: OnceLock<Mutex<DesktopSession>> = OnceLock::new();
static WALLPAPER_INPUT: OnceLock<Mutex<WallpaperInputState>> = OnceLock::new();

fn desktop_session() -> &'static Mutex<DesktopSession> {
    DESKTOP_SESSION.get_or_init(|| Mutex::new(DesktopSession::start()))
}

fn wallpaper_input() -> &'static Mutex<WallpaperInputState> {
    WALLPAPER_INPUT.get_or_init(|| Mutex::new(WallpaperInputState::default()))
}

fn with_desktop_session<T>(
    action: impl FnOnce(&mut DesktopSession) -> Result<T, String>,
) -> Result<T, String> {
    let mut session = desktop_session()
        .lock()
        .map_err(|_| "Desktop session lock was poisoned.".to_string())?;

    action(&mut session)
}

#[tauri::command]
fn desktop_status() -> Result<DesktopSessionInfo, String> {
    with_desktop_session(|session| Ok(session.status()))
}

#[tauri::command]
fn hide_desktop_icons(window: tauri::Window) -> Result<DesktopActionResult, String> {
    let position = window
        .outer_position()
        .map_err(|error| format!("Could not read window position: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("Could not read window size: {error}"))?;

    let window_rect = AppWindowRect {
        left: position.x,
        top: position.y,
        width: size.width as i32,
        height: size.height as i32,
    };

    with_desktop_session(|session| session.hide_icons(window_rect))
}

#[tauri::command]
fn restore_desktop_icons() -> Result<DesktopActionResult, String> {
    with_desktop_session(|session| session.restore_now())
}

#[tauri::command]
fn ensure_wallpaper_window(app: tauri::AppHandle) -> Result<WallpaperMetrics, String> {
    wallpaper::ensure_wallpaper_window(&app)
}

#[tauri::command]
fn wallpaper_status(app: tauri::AppHandle) -> Result<WallpaperMetrics, String> {
    Ok(wallpaper::wallpaper_status(&app))
}

#[tauri::command]
fn poll_wallpaper_click() -> Result<Option<WallpaperClick>, String> {
    let mut input = wallpaper_input()
        .lock()
        .map_err(|_| "Wallpaper input lock was poisoned.".to_string())?;

    input.poll_click()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let _ = desktop_session();
            if let Err(error) = wallpaper::ensure_wallpaper_window(app.handle()) {
                eprintln!("Failed to create wallpaper window: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) && window.label() == "main" {
                if let Ok(mut session) = desktop_session().lock() {
                    if let Err(error) = session.shutdown_restore() {
                        eprintln!("Failed to restore desktop on shutdown: {error}");
                    }
                }

                wallpaper::close_wallpaper_window(&window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            hide_desktop_icons,
            restore_desktop_icons,
            ensure_wallpaper_window,
            wallpaper_status,
            poll_wallpaper_click
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
