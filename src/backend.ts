import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export type RecoveryReport = {
  restored_count: number;
  message: string;
};

export type DesktopSessionInfo = {
  snapshot_path: string;
  icon_count: number;
  snap_to_grid: boolean;
  auto_arrange: boolean;
  hidden: boolean;
  startup_recovery?: RecoveryReport | null;
  warning?: string | null;
};

export type DesktopActionResult = {
  snapshot_path: string;
  icon_count: number;
  moved_count: number;
  snap_to_grid_was_on: boolean;
  auto_arrange_was_on: boolean;
  hidden: boolean;
  message: string;
};

export type WallpaperMetrics = {
  active: boolean;
  virtual_left: number;
  virtual_top: number;
  width: number;
  height: number;
  ground_y: number;
};

export type WallpaperClick = {
  id: number;
  x: number;
  y: number;
};

export function isTauriRuntime() {
  return Boolean(window.__TAURI_INTERNALS__);
}

export async function callBackend<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauriRuntime()) {
    return invoke<T>(command, args);
  }

  await new Promise((resolve) => window.setTimeout(resolve, 120));

  if (command === "hide_desktop_icons") {
    return {
      snapshot_path: "仅 Tauri 运行时有效",
      icon_count: 18,
      moved_count: 18,
      snap_to_grid_was_on: true,
      auto_arrange_was_on: false,
      hidden: true,
      message: "Preview mode",
    } as T;
  }

  if (command === "restore_desktop_icons") {
    return {
      snapshot_path: "仅 Tauri 运行时有效",
      icon_count: 18,
      moved_count: 18,
      snap_to_grid_was_on: true,
      auto_arrange_was_on: false,
      hidden: false,
      message: "Preview mode",
    } as T;
  }

  if (command === "ensure_wallpaper_window" || command === "wallpaper_status") {
    return previewWallpaperMetrics() as T;
  }

  if (command === "poll_wallpaper_click") {
    return null as T;
  }

  return {
    snapshot_path: "仅 Tauri 运行时有效",
    icon_count: 18,
    snap_to_grid: true,
    auto_arrange: false,
    hidden: false,
    startup_recovery: null,
    warning: null,
  } as T;
}

export function previewWallpaperMetrics(): WallpaperMetrics {
  return {
    active: true,
    virtual_left: 0,
    virtual_top: 0,
    width: window.innerWidth || 1280,
    height: window.innerHeight || 720,
    ground_y: Math.max(120, (window.innerHeight || 720) - 54),
  };
}
