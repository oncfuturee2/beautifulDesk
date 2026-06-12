use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{BOOL, HWND, LPARAM, POINT, RECT, WPARAM},
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
            WindowsAndMessaging::{
                EnumWindows, FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetCursorPos,
                GetParent, GetSystemMetrics, GetWindowLongPtrW, GetWindowRect, SendMessageTimeoutW,
                SetParent, SetWindowLongPtrW, SetWindowPos, ShowWindow, WindowFromPoint, GA_ROOT,
                GWL_EXSTYLE, GWL_STYLE, HWND_BOTTOM, SMTO_NORMAL, SM_CXVIRTUALSCREEN,
                SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SWP_FRAMECHANGED,
                SWP_NOACTIVATE, SWP_SHOWWINDOW, SW_SHOWNA, WS_CHILD, WS_CLIPCHILDREN,
                WS_CLIPSIBLINGS, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
                WS_EX_TRANSPARENT, WS_POPUP, WS_VISIBLE,
            },
        },
    },
};

pub const WALLPAPER_LABEL: &str = "wallpaper";

#[derive(Clone, Copy, Debug, Serialize)]
pub struct WallpaperMetrics {
    pub active: bool,
    pub virtual_left: i32,
    pub virtual_top: i32,
    pub width: i32,
    pub height: i32,
    pub ground_y: i32,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct WallpaperClick {
    pub id: u64,
    pub x: i32,
    pub y: i32,
}

#[derive(Default)]
pub struct WallpaperInputState {
    left_was_down: bool,
    next_click_id: u64,
}

impl WallpaperInputState {
    pub fn poll_click(&mut self) -> Result<Option<WallpaperClick>, String> {
        let key_state = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) };
        let is_down = key_state < 0;
        let pressed_since_last_poll = key_state & 0x0001 != 0;
        let became_down = pressed_since_last_poll || (is_down && !self.left_was_down);
        self.left_was_down = is_down;

        if !became_down {
            return Ok(None);
        }

        let mut point = POINT { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut point)
                .map_err(|error| format!("Could not read mouse cursor position: {error}"))?;
        }

        let metrics = current_metrics(false);
        let local_x = point.x - metrics.virtual_left;
        let local_y = point.y - metrics.virtual_top;

        if local_x < 0 || local_y < 0 || local_x >= metrics.width || local_y >= metrics.ground_y {
            return Ok(None);
        }

        if !is_desktop_click_target(point) {
            return Ok(None);
        }

        self.next_click_id = self.next_click_id.saturating_add(1);

        Ok(Some(WallpaperClick {
            id: self.next_click_id,
            x: local_x,
            y: local_y,
        }))
    }
}

pub fn ensure_wallpaper_window(app: &AppHandle) -> Result<WallpaperMetrics, String> {
    if let Some(window) = app.get_webview_window(WALLPAPER_LABEL) {
        attach_to_desktop(&window)?;
        return Ok(current_metrics(true));
    }

    let metrics = current_metrics(true);
    let url = WebviewUrl::App("index.html?view=wallpaper".into());
    let window = WebviewWindowBuilder::new(app, WALLPAPER_LABEL, url)
        .title("BeautifulDesk 壁纸窗口")
        .transparent(true)
        .decorations(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .inner_size(metrics.width as f64, metrics.height as f64)
        .position(metrics.virtual_left as f64, metrics.virtual_top as f64)
        .build()
        .map_err(|error| format!("Could not create wallpaper window: {error}"))?;

    attach_to_desktop(&window)?;
    window
        .show()
        .map_err(|error| format!("Could not show wallpaper window: {error}"))?;

    Ok(metrics)
}

pub fn wallpaper_status(app: &AppHandle) -> WallpaperMetrics {
    current_metrics(app.get_webview_window(WALLPAPER_LABEL).is_some())
}

pub fn close_wallpaper_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WALLPAPER_LABEL) {
        let _ = window.close();
    }
}

fn attach_to_desktop(window: &WebviewWindow) -> Result<(), String> {
    let metrics = current_metrics(true);
    let host = find_wallpaper_host().ok_or_else(|| {
        "Could not locate the Windows desktop host for the wallpaper window.".to_string()
    })?;
    let raw_hwnd = window
        .hwnd()
        .map_err(|error| format!("Could not read wallpaper HWND: {error}"))?;
    let hwnd = HWND(raw_hwnd.0 as isize);

    unsafe {
        SetParent(hwnd, host);

        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let style = (style
            | WS_CHILD.0 as isize
            | WS_VISIBLE.0 as isize
            | WS_CLIPSIBLINGS.0 as isize
            | WS_CLIPCHILDREN.0 as isize)
            & !(WS_POPUP.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_STYLE, style);

        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let ex_style = (ex_style
            | WS_EX_TOOLWINDOW.0 as isize
            | WS_EX_NOACTIVATE.0 as isize
            | WS_EX_TRANSPARENT.0 as isize)
            & !(WS_EX_APPWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style);

        let mut host_rect = RECT::default();
        GetWindowRect(host, &mut host_rect)
            .map_err(|error| format!("Could not read wallpaper host rectangle: {error}"))?;

        let x = metrics.virtual_left - host_rect.left;
        let y = metrics.virtual_top - host_rect.top;

        SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            x,
            y,
            metrics.width,
            metrics.height,
            SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        )
        .map_err(|error| format!("Could not position wallpaper window: {error}"))?;

        ShowWindow(hwnd, SW_SHOWNA);
    }

    Ok(())
}

fn current_metrics(active: bool) -> WallpaperMetrics {
    let virtual_left = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
    let virtual_top = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
    let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) }.max(1);
    let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) }.max(1);
    let ground_y = taskbar_ground_y(virtual_left, virtual_top, width, height);

    WallpaperMetrics {
        active,
        virtual_left,
        virtual_top,
        width,
        height,
        ground_y,
    }
}

fn taskbar_ground_y(virtual_left: i32, virtual_top: i32, width: i32, height: i32) -> i32 {
    unsafe {
        let taskbar = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null());
        if taskbar.0 == 0 {
            return height;
        }

        let mut rect = RECT::default();
        if GetWindowRect(taskbar, &mut rect).is_err() {
            return height;
        }

        let is_bottom_taskbar = rect.top > virtual_top + height / 2
            && rect.right > virtual_left
            && rect.left < virtual_left + width;

        if is_bottom_taskbar {
            (rect.top - virtual_top).clamp(1, height)
        } else {
            height
        }
    }
}

fn find_wallpaper_host() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null());
        if progman.0 == 0 {
            return None;
        }

        let mut message_result = 0usize;
        let _ = SendMessageTimeoutW(
            progman,
            0x052C,
            WPARAM(0),
            LPARAM(0),
            SMTO_NORMAL,
            1000,
            Some(&mut message_result),
        );

        let mut found = HWND(0);
        let found_ptr = &mut found as *mut HWND;
        let _ = EnumWindows(
            Some(enum_windows_for_wallpaper_host),
            LPARAM(found_ptr as isize),
        );

        if found.0 != 0 {
            Some(found)
        } else {
            Some(progman)
        }
    }
}

unsafe extern "system" fn enum_windows_for_wallpaper_host(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let shell_view = FindWindowExW(hwnd, HWND(0), w!("SHELLDLL_DefView"), PCWSTR::null());

    if shell_view.0 == 0 {
        return BOOL(1);
    }

    let worker = FindWindowExW(HWND(0), hwnd, w!("WorkerW"), PCWSTR::null());

    if worker.0 != 0 {
        let found_ptr = lparam.0 as *mut HWND;
        if !found_ptr.is_null() {
            *found_ptr = worker;
        }
        return BOOL(0);
    }

    BOOL(1)
}

fn is_desktop_click_target(point: POINT) -> bool {
    unsafe {
        let mut hwnd = WindowFromPoint(point);
        if hwnd.0 == 0 {
            return false;
        }

        let root = GetAncestor(hwnd, GA_ROOT);
        if root.0 != 0 && is_desktop_window(root) {
            return true;
        }

        while hwnd.0 != 0 {
            if is_desktop_window(hwnd) {
                return true;
            }

            hwnd = GetParent(hwnd);
        }

        false
    }
}

fn is_desktop_window(hwnd: HWND) -> bool {
    let class_name = class_name(hwnd);

    if matches!(
        class_name.as_str(),
        "SysListView32" | "SHELLDLL_DefView" | "WorkerW" | "Progman"
    ) {
        return true;
    }

    unsafe {
        FindWindowExW(hwnd, HWND(0), w!("SHELLDLL_DefView"), PCWSTR::null()).0 != 0
            || FindWindowExW(hwnd, HWND(0), w!("SysListView32"), w!("FolderView")).0 != 0
    }
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 128];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };

    if len <= 0 {
        String::new()
    } else {
        String::from_utf16_lossy(&buffer[..len as usize])
    }
}
