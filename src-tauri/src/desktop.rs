use serde::{Deserialize, Serialize};
use std::{
    cmp,
    ffi::c_void,
    fs,
    io::ErrorKind,
    mem::size_of,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        System::{
            Diagnostics::Debug::{ReadProcessMemory, WriteProcessMemory},
            Memory::{
                VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
            },
            Threading::{
                OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ,
                PROCESS_VM_WRITE,
            },
        },
        UI::{
            Controls::{
                LVM_GETEXTENDEDLISTVIEWSTYLE, LVM_GETITEMCOUNT, LVM_GETITEMPOSITION,
                LVM_SETEXTENDEDLISTVIEWSTYLE, LVM_SETITEMPOSITION32, LVS_AUTOARRANGE,
                LVS_EX_SNAPTOGRID,
            },
            WindowsAndMessaging::{
                EnumWindows, FindWindowExW, FindWindowW, GetWindowLongPtrW, GetWindowRect,
                GetWindowThreadProcessId, SendMessageW, SetWindowLongPtrW, SetWindowPos, GWL_STYLE,
                SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            },
        },
    },
};

const RECORD_FILE_NAME: &str = "beautifuldesk-desktop-restore.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct AppWindowRect {
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct DesktopSessionInfo {
    pub snapshot_path: String,
    pub icon_count: usize,
    pub snap_to_grid: bool,
    pub auto_arrange: bool,
    pub hidden: bool,
    pub startup_recovery: Option<RecoveryReport>,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DesktopActionResult {
    pub snapshot_path: String,
    pub icon_count: usize,
    pub moved_count: usize,
    pub snap_to_grid_was_on: bool,
    pub auto_arrange_was_on: bool,
    pub hidden: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct RecoveryReport {
    pub restored_count: usize,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DesktopRecord {
    version: u32,
    captured_at_ms: u128,
    hidden_at_ms: Option<u128>,
    modified: bool,
    styles: DesktopStyles,
    icons: Vec<IconSnapshot>,
    hidden_window: Option<AppWindowRect>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DesktopStyles {
    snap_to_grid: bool,
    auto_arrange: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct IconSnapshot {
    index: i32,
    x: i32,
    y: i32,
}

pub struct DesktopSession {
    record_path: PathBuf,
    record: Option<DesktopRecord>,
    startup_recovery: Option<RecoveryReport>,
    warning: Option<String>,
}

impl DesktopSession {
    pub fn start() -> Self {
        let mut session = Self {
            record_path: std::env::temp_dir().join(RECORD_FILE_NAME),
            record: None,
            startup_recovery: None,
            warning: None,
        };

        session.bootstrap();
        session
    }

    pub fn status(&mut self) -> DesktopSessionInfo {
        if self.record.is_none() {
            self.capture_and_store(false);
        }

        let (icon_count, snap_to_grid, auto_arrange, hidden) = self
            .record
            .as_ref()
            .map(|record| {
                (
                    record.icons.len(),
                    record.styles.snap_to_grid,
                    record.styles.auto_arrange,
                    record.modified,
                )
            })
            .unwrap_or((0, false, false, false));

        DesktopSessionInfo {
            snapshot_path: self.record_path.display().to_string(),
            icon_count,
            snap_to_grid,
            auto_arrange,
            hidden,
            startup_recovery: self.startup_recovery.clone(),
            warning: self.warning.clone(),
        }
    }

    pub fn hide_icons(
        &mut self,
        window_rect: AppWindowRect,
    ) -> Result<DesktopActionResult, String> {
        if self.record.as_ref().is_some_and(|record| record.modified) {
            let record = self.record.as_ref().expect("record checked above");
            return Ok(DesktopActionResult {
                snapshot_path: self.record_path.display().to_string(),
                icon_count: record.icons.len(),
                moved_count: 0,
                snap_to_grid_was_on: record.styles.snap_to_grid,
                auto_arrange_was_on: record.styles.auto_arrange,
                hidden: true,
                message: "Desktop icons are already hidden by this session.".into(),
            });
        }

        let mut record = capture_record(false)?;
        record.modified = true;
        record.hidden_at_ms = Some(now_ms());
        record.hidden_window = Some(window_rect);

        write_record(&self.record_path, &record)?;

        match move_icons_behind_window(&record, window_rect) {
            Ok(moved_count) => {
                self.record = Some(record.clone());
                Ok(DesktopActionResult {
                    snapshot_path: self.record_path.display().to_string(),
                    icon_count: record.icons.len(),
                    moved_count,
                    snap_to_grid_was_on: record.styles.snap_to_grid,
                    auto_arrange_was_on: record.styles.auto_arrange,
                    hidden: true,
                    message: "Desktop icons moved behind the app window.".into(),
                })
            }
            Err(error) => {
                self.record = Some(record);
                Err(format!(
                    "{error}. A recovery record is still available at {}.",
                    self.record_path.display()
                ))
            }
        }
    }

    pub fn restore_now(&mut self) -> Result<DesktopActionResult, String> {
        let Some(record) = self.record.clone() else {
            self.capture_and_store(false);
            return Err("No desktop snapshot is available yet.".into());
        };

        if !record.modified {
            delete_record(&self.record_path)?;
            self.record = None;
            self.capture_and_store(false);

            return Ok(DesktopActionResult {
                snapshot_path: self.record_path.display().to_string(),
                icon_count: record.icons.len(),
                moved_count: 0,
                snap_to_grid_was_on: record.styles.snap_to_grid,
                auto_arrange_was_on: record.styles.auto_arrange,
                hidden: false,
                message: "No desktop changes needed recovery.".into(),
            });
        }

        let moved_count = restore_from_record(&record)?;
        delete_record(&self.record_path)?;
        self.record = None;
        self.capture_and_store(false);

        Ok(DesktopActionResult {
            snapshot_path: self.record_path.display().to_string(),
            icon_count: record.icons.len(),
            moved_count,
            snap_to_grid_was_on: record.styles.snap_to_grid,
            auto_arrange_was_on: record.styles.auto_arrange,
            hidden: false,
            message: "Desktop icon layout restored.".into(),
        })
    }

    pub fn shutdown_restore(&mut self) -> Result<(), String> {
        let Some(record) = self.record.clone() else {
            return Ok(());
        };

        if record.modified {
            restore_from_record(&record)?;
        }

        delete_record(&self.record_path)?;
        self.record = None;
        Ok(())
    }

    fn bootstrap(&mut self) {
        match read_record(&self.record_path) {
            Ok(Some(record)) if record.modified => match restore_from_record(&record) {
                Ok(restored_count) => {
                    if let Err(error) = delete_record(&self.record_path) {
                        self.warning = Some(error);
                    }

                    self.startup_recovery = Some(RecoveryReport {
                        restored_count,
                        message: "Recovered a previous interrupted desktop prank.".into(),
                    });
                }
                Err(error) => {
                    self.warning = Some(format!(
                        "Previous recovery record could not be restored: {error}"
                    ));
                    self.record = Some(record);
                    return;
                }
            },
            Ok(Some(_record)) => {
                if let Err(error) = delete_record(&self.record_path) {
                    self.warning = Some(error);
                }
            }
            Ok(None) => {}
            Err(error) => {
                self.warning = Some(format!("Could not read recovery record: {error}"));
            }
        }

        self.capture_and_store(false);
    }

    fn capture_and_store(&mut self, modified: bool) {
        match capture_record(modified) {
            Ok(record) => {
                if let Err(error) = write_record(&self.record_path, &record) {
                    self.warning = Some(error);
                }
                self.record = Some(record);
            }
            Err(error) => {
                self.warning = Some(format!("Could not capture desktop snapshot: {error}"));
            }
        }
    }
}

fn capture_record(modified: bool) -> Result<DesktopRecord, String> {
    let desktop = DesktopListView::open()?;
    let icon_count = desktop.item_count()?;
    let styles = desktop.styles();
    let mut icons = Vec::with_capacity(icon_count);

    for index in 0..icon_count {
        let point = desktop.item_position(index as i32)?;
        icons.push(IconSnapshot {
            index: index as i32,
            x: point.x,
            y: point.y,
        });
    }

    Ok(DesktopRecord {
        version: 1,
        captured_at_ms: now_ms(),
        hidden_at_ms: None,
        modified,
        styles,
        icons,
        hidden_window: None,
    })
}

fn move_icons_behind_window(
    record: &DesktopRecord,
    window_rect: AppWindowRect,
) -> Result<usize, String> {
    let desktop = DesktopListView::open()?;
    desktop.set_auto_arrange(false)?;
    desktop.set_snap_to_grid(false)?;

    let current_count = desktop.item_count()?;
    let desktop_rect = desktop.window_rect()?;
    let positions = hidden_positions(record.icons.len(), window_rect, desktop_rect);
    let mut moved_count = 0;

    for (icon, point) in record.icons.iter().zip(positions.iter()) {
        if icon.index >= 0 && (icon.index as usize) < current_count {
            desktop.set_item_position(icon.index, point.x, point.y)?;
            moved_count += 1;
        }
    }

    Ok(moved_count)
}

fn restore_from_record(record: &DesktopRecord) -> Result<usize, String> {
    let desktop = DesktopListView::open()?;
    desktop.set_auto_arrange(false)?;
    desktop.set_snap_to_grid(false)?;

    let current_count = desktop.item_count()?;
    let mut moved_count = 0;

    for icon in &record.icons {
        if icon.index >= 0 && (icon.index as usize) < current_count {
            desktop.set_item_position(icon.index, icon.x, icon.y)?;
            moved_count += 1;
        }
    }

    desktop.set_snap_to_grid(record.styles.snap_to_grid)?;
    desktop.set_auto_arrange(record.styles.auto_arrange)?;

    Ok(moved_count)
}

fn hidden_positions(count: usize, window_rect: AppWindowRect, desktop_rect: RECT) -> Vec<POINT> {
    if count == 0 {
        return Vec::new();
    }

    let desktop_left = desktop_rect.left;
    let desktop_top = desktop_rect.top;
    let relative_left = window_rect.left - desktop_left;
    let relative_top = window_rect.top - desktop_top;
    let width = cmp::max(window_rect.width, 260);
    let height = cmp::max(window_rect.height, 220);
    let margin_x = (width / 9).clamp(42, 92);
    let margin_y = (height / 8).clamp(44, 88);
    let left = relative_left + margin_x;
    let top = relative_top + margin_y;
    let right = relative_left + width - margin_x;
    let bottom = relative_top + height - margin_y;
    let cell_w = 74;
    let cell_h = 86;
    let usable_w = cmp::max(right - left, cell_w);
    let usable_h = cmp::max(bottom - top, cell_h);
    let cols = cmp::max(1, usable_w / cell_w);
    let rows = cmp::max(1, usable_h / cell_h);
    let center_x = relative_left + width / 2 - 32;
    let center_y = relative_top + height / 2 - 32;

    (0..count)
        .map(|index| {
            let col = (index as i32) % cols;
            let row = ((index as i32) / cols) % rows;
            let jitter_x = ((index as i32 * 37) % 21) - 10;
            let jitter_y = ((index as i32 * 29) % 19) - 9;
            let x = if right > left {
                left + col * cell_w + jitter_x
            } else {
                center_x + jitter_x
            };
            let y = if bottom > top {
                top + row * cell_h + jitter_y
            } else {
                center_y + jitter_y
            };

            POINT { x, y }
        })
        .collect()
}

fn read_record(path: &Path) -> Result<Option<DesktopRecord>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let record = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;

    Ok(Some(record))
}

fn write_record(path: &Path, record: &DesktopRecord) -> Result<(), String> {
    let temp_path = path.with_extension("json.tmp");
    let content = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("Failed to serialize recovery record: {error}"))?;

    fs::write(&temp_path, content)
        .map_err(|error| format!("Failed to write {}: {error}", temp_path.display()))?;

    fs::copy(&temp_path, path)
        .map_err(|error| format!("Failed to activate {}: {error}", path.display()))?;
    fs::remove_file(&temp_path)
        .map_err(|error| format!("Failed to clean {}: {error}", temp_path.display()))
}

fn delete_record(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to delete {}: {error}", path.display())),
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

struct DesktopListView {
    hwnd: HWND,
    process: HANDLE,
    remote_point: *mut c_void,
}

impl DesktopListView {
    fn open() -> Result<Self, String> {
        let hwnd = find_desktop_listview()
            .ok_or_else(|| "Could not locate the Windows desktop icon view.".to_string())?;
        let mut process_id = 0u32;

        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        }

        if process_id == 0 {
            return Err("Could not resolve Explorer process for the desktop view.".into());
        }

        let access =
            PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE;
        let process = unsafe { OpenProcess(access, false, process_id) }
            .map_err(|error| format!("Could not open Explorer process: {error}"))?;
        let remote_point = unsafe {
            VirtualAllocEx(
                process,
                None,
                size_of::<POINT>(),
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            )
        };

        if remote_point.is_null() {
            unsafe {
                let _ = CloseHandle(process);
            }

            return Err("Could not allocate shared point memory in Explorer.".into());
        }

        Ok(Self {
            hwnd,
            process,
            remote_point,
        })
    }

    fn item_count(&self) -> Result<usize, String> {
        let result = self.send(LVM_GETITEMCOUNT, WPARAM(0), LPARAM(0));
        if result.0 < 0 {
            return Err("Desktop icon count returned an invalid value.".into());
        }

        Ok(result.0 as usize)
    }

    fn item_position(&self, index: i32) -> Result<POINT, String> {
        let result = self.send(
            LVM_GETITEMPOSITION,
            WPARAM(index as usize),
            LPARAM(self.remote_point as isize),
        );

        if result.0 == 0 {
            return Err(format!(
                "Could not read desktop icon position at index {index}."
            ));
        }

        let mut point = POINT { x: 0, y: 0 };
        let mut bytes_read = 0usize;

        unsafe {
            ReadProcessMemory(
                self.process,
                self.remote_point,
                &mut point as *mut POINT as *mut c_void,
                size_of::<POINT>(),
                Some(&mut bytes_read),
            )
            .map_err(|error| format!("Could not copy icon position from Explorer: {error}"))?;
        }

        Ok(point)
    }

    fn set_item_position(&self, index: i32, x: i32, y: i32) -> Result<(), String> {
        let point = POINT { x, y };
        let mut bytes_written = 0usize;

        unsafe {
            WriteProcessMemory(
                self.process,
                self.remote_point,
                &point as *const POINT as *const c_void,
                size_of::<POINT>(),
                Some(&mut bytes_written),
            )
            .map_err(|error| format!("Could not copy target icon position to Explorer: {error}"))?;
        }

        let result = self.send(
            LVM_SETITEMPOSITION32,
            WPARAM(index as usize),
            LPARAM(self.remote_point as isize),
        );

        if result.0 == 0 {
            return Err(format!("Could not move desktop icon at index {index}."));
        }

        Ok(())
    }

    fn styles(&self) -> DesktopStyles {
        let style = unsafe { GetWindowLongPtrW(self.hwnd, GWL_STYLE) };
        let extended = self
            .send(LVM_GETEXTENDEDLISTVIEWSTYLE, WPARAM(0), LPARAM(0))
            .0 as u32;

        DesktopStyles {
            snap_to_grid: extended & LVS_EX_SNAPTOGRID != 0,
            auto_arrange: (style as u32) & LVS_AUTOARRANGE != 0,
        }
    }

    fn set_snap_to_grid(&self, enabled: bool) -> Result<(), String> {
        let current = self
            .send(LVM_GETEXTENDEDLISTVIEWSTYLE, WPARAM(0), LPARAM(0))
            .0 as u32;
        let next = if enabled {
            current | LVS_EX_SNAPTOGRID
        } else {
            current & !LVS_EX_SNAPTOGRID
        };

        self.send(
            LVM_SETEXTENDEDLISTVIEWSTYLE,
            WPARAM(LVS_EX_SNAPTOGRID as usize),
            LPARAM(next as isize),
        );

        Ok(())
    }

    fn set_auto_arrange(&self, enabled: bool) -> Result<(), String> {
        let current = unsafe { GetWindowLongPtrW(self.hwnd, GWL_STYLE) };
        let flag = LVS_AUTOARRANGE as isize;
        let next = if enabled {
            current | flag
        } else {
            current & !flag
        };

        unsafe {
            SetWindowLongPtrW(self.hwnd, GWL_STYLE, next);
            SetWindowPos(
                self.hwnd,
                HWND(0),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
            )
            .map_err(|error| format!("Could not refresh desktop view styles: {error}"))?;
        }

        Ok(())
    }

    fn window_rect(&self) -> Result<RECT, String> {
        let mut rect = RECT::default();
        unsafe {
            GetWindowRect(self.hwnd, &mut rect)
                .map_err(|error| format!("Could not read desktop view rectangle: {error}"))?;
        }
        Ok(rect)
    }

    fn send(&self, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        unsafe { SendMessageW(self.hwnd, message, wparam, lparam) }
    }
}

impl Drop for DesktopListView {
    fn drop(&mut self) {
        unsafe {
            if !self.remote_point.is_null() {
                let _ = VirtualFreeEx(self.process, self.remote_point, 0, MEM_RELEASE);
            }

            if self.process.0 != 0 {
                let _ = CloseHandle(self.process);
            }
        }
    }
}

fn find_desktop_listview() -> Option<HWND> {
    unsafe {
        let progman = FindWindowW(w!("Progman"), PCWSTR::null());
        let shell_view = FindWindowExW(progman, HWND(0), w!("SHELLDLL_DefView"), PCWSTR::null());

        if shell_view.0 != 0 {
            let list_view =
                FindWindowExW(shell_view, HWND(0), w!("SysListView32"), w!("FolderView"));

            if list_view.0 != 0 {
                return Some(list_view);
            }
        }

        let mut found = HWND(0);
        let found_ptr = &mut found as *mut HWND;
        let _ = EnumWindows(Some(enum_windows_for_desktop), LPARAM(found_ptr as isize));

        if found.0 == 0 {
            None
        } else {
            Some(found)
        }
    }
}

unsafe extern "system" fn enum_windows_for_desktop(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let shell_view = FindWindowExW(hwnd, HWND(0), w!("SHELLDLL_DefView"), PCWSTR::null());

    if shell_view.0 == 0 {
        return BOOL(1);
    }

    let list_view = FindWindowExW(shell_view, HWND(0), w!("SysListView32"), w!("FolderView"));

    if list_view.0 != 0 {
        let found_ptr = lparam.0 as *mut HWND;
        if !found_ptr.is_null() {
            *found_ptr = list_view;
        }
        return BOOL(0);
    }

    BOOL(1)
}
