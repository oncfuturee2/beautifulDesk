import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  callBackend,
  type DesktopActionResult,
  type DesktopSessionInfo,
  type WallpaperMetrics,
} from "./backend";
import WallpaperWindow from "./WallpaperWindow";
import WebGLWaterSurface from "./WebGLWaterSurface";
import "./App.css";

type Phase = "booting" | "ready" | "breaking" | "hidden" | "restoring" | "error";

type CssVars = CSSProperties & Record<`--${string}`, string>;

const BUTTON_COLS = 12;
const BUTTON_ROWS = 6;
const BUTTON_PIECES = Array.from({ length: BUTTON_COLS * BUTTON_ROWS }, (_, index) => ({
  index,
  col: index % BUTTON_COLS,
  row: Math.floor(index / BUTTON_COLS),
}));

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function OrganizeApp() {
  const [phase, setPhase] = useState<Phase>("booting");
  const [status, setStatus] = useState<DesktopSessionInfo | null>(null);
  const [wallpaper, setWallpaper] = useState<WallpaperMetrics | null>(null);
  const [wallpaperBusy, setWallpaperBusy] = useState(false);
  const [waterReady, setWaterReady] = useState(false);
  const [message, setMessage] = useState("正在记录桌面快照");
  const stageRef = useRef<HTMLElement | null>(null);
  const breakTimer = useRef<number | null>(null);

  const refreshWallpaperStatus = useCallback(async () => {
    const nextWallpaper = await callBackend<WallpaperMetrics>("wallpaper_status");
    setWallpaper(nextWallpaper);
    return nextWallpaper;
  }, []);

  const loadStatus = useCallback(async () => {
    const [info] = await Promise.all([
      callBackend<DesktopSessionInfo>("desktop_status"),
      refreshWallpaperStatus().catch(() => null),
    ]);

    setStatus(info);

    if (info.hidden) {
      setPhase("hidden");
      setMessage("检测到仍需复原的桌面记录");
      return;
    }

    setPhase("ready");

    if (info.startup_recovery) {
      setMessage(`已恢复上次中断的布局：${info.startup_recovery.restored_count} 个图标`);
    } else if (info.warning) {
      setMessage(info.warning);
    } else {
      setMessage(`快照已记录：${info.icon_count} 个桌面图标`);
    }
  }, [refreshWallpaperStatus]);

  useEffect(() => {
    let mounted = true;

    loadStatus().catch((error) => {
      if (!mounted) return;
      setPhase("error");
      setMessage(asErrorMessage(error));
    });

    return () => {
      mounted = false;
      if (breakTimer.current !== null) {
        window.clearTimeout(breakTimer.current);
      }
    };
  }, [loadStatus]);

  const statusItems = useMemo(() => {
    if (!status) {
      return ["快照 读取中", "网格对齐 检查中", "自动排列 检查中", "壁纸窗口 检查中"];
    }

    return [
      `快照 ${status.icon_count} 个`,
      `网格对齐 ${status.snap_to_grid ? "开启" : "关闭"}`,
      `自动排列 ${status.auto_arrange ? "开启" : "关闭"}`,
      `壁纸窗口 ${wallpaper?.active ? "开启" : "未开启"}`,
    ];
  }, [status, wallpaper?.active]);

  const handleOrganize = async () => {
    if (phase === "breaking" || phase === "hidden" || phase === "restoring") {
      return;
    }

    setPhase("breaking");
    setMessage("整理中");

    breakTimer.current = window.setTimeout(async () => {
      try {
        const result = await callBackend<DesktopActionResult>("hide_desktop_icons");
        const info = await callBackend<DesktopSessionInfo>("desktop_status");
        setStatus(info);
        setPhase("hidden");
        setMessage(`已藏起 ${result.moved_count}/${result.icon_count} 个图标`);
      } catch (error) {
        setPhase("error");
        setMessage(asErrorMessage(error));
      }
    }, 1550);
  };

  const handleRestore = async () => {
    if (phase === "restoring") {
      return;
    }

    setPhase("restoring");
    setMessage("正在复原桌面");

    try {
      const result = await callBackend<DesktopActionResult>("restore_desktop_icons");
      await loadStatus();
      setMessage(`桌面已复原：${result.moved_count} 个图标`);
    } catch (error) {
      setPhase("error");
      setMessage(asErrorMessage(error));
    }
  };

  const handleWallpaper = async () => {
    if (wallpaperBusy) {
      return;
    }

    setWallpaperBusy(true);

    try {
      const nextWallpaper = await callBackend<WallpaperMetrics>("ensure_wallpaper_window");
      setWallpaper(nextWallpaper);
      setMessage("壁纸窗口已开启");
    } catch (error) {
      setPhase("error");
      setMessage(asErrorMessage(error));
    } finally {
      setWallpaperBusy(false);
    }
  };

  const showMainButton = phase === "ready" || phase === "breaking" || phase === "error";
  const canRestore = phase === "hidden" || status?.hidden;
  const captureKey = `${phase}:${message}:${status?.icon_count ?? 0}:${wallpaper?.active ?? false}`;

  return (
    <main className={`app-shell ${waterReady ? "is-water-ready" : ""}`}>
      <WebGLWaterSurface
        targetRef={stageRef}
        captureKey={captureKey}
        onReady={setWaterReady}
      />

      <section className="stage" ref={stageRef}>
        <header className="topbar">
          <div className="brand-block">
            <span className="app-mark" aria-hidden="true" />
            <div>
              <p className="eyebrow">BeautifulDesk</p>
              <h1>整理</h1>
            </div>
          </div>

          <div className="desktop-state" aria-label="桌面状态">
            {statusItems.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>

          <div className="command-group">
            <button
              className="wallpaper-command"
              type="button"
              onClick={handleWallpaper}
              disabled={wallpaperBusy || wallpaper?.active}
            >
              壁纸窗口
            </button>
            <button
              className="restore-command"
              type="button"
              onClick={handleRestore}
              disabled={!canRestore || phase === "restoring"}
            >
              复原
            </button>
          </div>
        </header>

        <section className="center-zone" aria-live="polite">
          {showMainButton ? (
            <button
              className={`organize-button ${phase === "breaking" ? "is-breaking" : ""}`}
              type="button"
              onClick={handleOrganize}
              disabled={phase === "breaking"}
            >
              <span className="button-glass" aria-hidden="true" />
              <span className="button-label">整理桌面图标</span>
              <span className="piece-layer" aria-hidden="true">
                {BUTTON_PIECES.map((piece) => {
                  const hue = (34 + piece.col * 9 + piece.row * 24) % 360;
                  const style: CssVars = {
                    left: `${(piece.col / BUTTON_COLS) * 100}%`,
                    top: `${(piece.row / BUTTON_ROWS) * 100}%`,
                    width: `${100 / BUTTON_COLS}%`,
                    height: `${100 / BUTTON_ROWS}%`,
                    "--fall-delay": `${(BUTTON_ROWS - piece.row - 1) * 58 + piece.col * 8}ms`,
                    "--drift-x": `${(piece.col - (BUTTON_COLS - 1) / 2) * 16}px`,
                    "--fall-y": `${238 + piece.row * 24}px`,
                    "--spin": `${piece.index % 2 === 0 ? 1 : -1}${120 + piece.row * 24}deg`,
                    background: `linear-gradient(135deg, hsl(${hue} 88% 62%), hsl(${(hue + 132) % 360} 75% 58%))`,
                  };

                  return <span className="shatter-piece" key={piece.index} style={style} />;
                })}
              </span>
            </button>
          ) : (
            <div className="after-state">
              <p>{phase === "restoring" ? "复原中" : "已整理"}</p>
              <button type="button" onClick={handleRestore} disabled={phase === "restoring"}>
                复原桌面
              </button>
            </div>
          )}

          <p className={`live-message ${phase === "error" ? "is-error" : ""}`}>{message}</p>
        </section>

        <footer className="snapshot-line">
          <span>临时记录</span>
          <code>{status?.snapshot_path ?? "准备中"}</code>
        </footer>
      </section>
    </main>
  );
}

function App() {
  const view = new URLSearchParams(window.location.search).get("view");

  if (view === "wallpaper") {
    return <WallpaperWindow />;
  }

  return <OrganizeApp />;
}

export default App;
