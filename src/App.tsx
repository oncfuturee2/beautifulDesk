import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "./App.css";

type Phase = "booting" | "ready" | "breaking" | "hidden" | "restoring" | "error";

type RecoveryReport = {
  restored_count: number;
  message: string;
};

type DesktopSessionInfo = {
  snapshot_path: string;
  icon_count: number;
  snap_to_grid: boolean;
  auto_arrange: boolean;
  hidden: boolean;
  startup_recovery?: RecoveryReport | null;
  warning?: string | null;
};

type DesktopActionResult = {
  snapshot_path: string;
  icon_count: number;
  moved_count: number;
  snap_to_grid_was_on: boolean;
  auto_arrange_was_on: boolean;
  hidden: boolean;
  message: string;
};

type Ripple = {
  id: number;
  x: number;
  y: number;
};

type CssVars = CSSProperties & Record<`--${string}`, string>;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

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

async function callBackend<T>(command: string): Promise<T> {
  if (window.__TAURI_INTERNALS__) {
    return invoke<T>(command);
  }

  await new Promise((resolve) => window.setTimeout(resolve, 220));

  if (command === "hide_desktop_icons") {
    return {
      snapshot_path: "Tauri 运行时内有效",
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
      snapshot_path: "Tauri 运行时内有效",
      icon_count: 18,
      moved_count: 18,
      snap_to_grid_was_on: true,
      auto_arrange_was_on: false,
      hidden: false,
      message: "Preview mode",
    } as T;
  }

  return {
    snapshot_path: "Tauri 运行时内有效",
    icon_count: 18,
    snap_to_grid: true,
    auto_arrange: false,
    hidden: false,
    startup_recovery: null,
    warning: null,
  } as T;
}

function App() {
  const [phase, setPhase] = useState<Phase>("booting");
  const [status, setStatus] = useState<DesktopSessionInfo | null>(null);
  const [message, setMessage] = useState("正在记录桌面快照");
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [cursorStyle, setCursorStyle] = useState<CssVars>({
    "--cursor-x": "50%",
    "--cursor-y": "50%",
  });
  const rippleId = useRef(0);
  const lastRippleAt = useRef(0);
  const breakTimer = useRef<number | null>(null);

  const loadStatus = useCallback(async () => {
    const info = await callBackend<DesktopSessionInfo>("desktop_status");
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
  }, []);

  useEffect(() => {
    let mounted = true;

    callBackend<DesktopSessionInfo>("desktop_status")
      .then((info) => {
        if (!mounted) return;
        setStatus(info);

        if (info.hidden) {
          setPhase("hidden");
          setMessage("检测到仍需复原的桌面记录");
        } else {
          setPhase("ready");
          setMessage(
            info.startup_recovery
              ? `已恢复上次中断的布局：${info.startup_recovery.restored_count} 个图标`
              : `快照已记录：${info.icon_count} 个桌面图标`,
          );
        }
      })
      .catch((error) => {
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
  }, []);

  const statusItems = useMemo(() => {
    if (!status) {
      return ["快照 读取中", "网格对齐 检查中", "自动排列 检查中"];
    }

    return [
      `快照 ${status.icon_count} 个`,
      `网格对齐 ${status.snap_to_grid ? "开启" : "关闭"}`,
      `自动排列 ${status.auto_arrange ? "开启" : "关闭"}`,
    ];
  }, [status]);

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    setCursorStyle({
      "--cursor-x": `${event.clientX}px`,
      "--cursor-y": `${event.clientY}px`,
    });

    const now = window.performance.now();
    if (now - lastRippleAt.current < 95) {
      return;
    }

    lastRippleAt.current = now;
    const id = rippleId.current + 1;
    rippleId.current = id;
    setRipples((current) => [...current.slice(-8), { id, x: event.clientX, y: event.clientY }]);
    window.setTimeout(() => {
      setRipples((current) => current.filter((ripple) => ripple.id !== id));
    }, 1250);
  };

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

  const showMainButton = phase === "ready" || phase === "breaking" || phase === "error";
  const canRestore = phase === "hidden" || status?.hidden;

  return (
    <main className="app-shell" style={cursorStyle} onPointerMove={handlePointerMove}>
      <svg className="filter-defs" aria-hidden="true" focusable="false">
        <filter id="water-distortion">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.012 0.026"
            numOctaves="2"
            seed="11"
            result="noise"
          >
            <animate
              attributeName="baseFrequency"
              dur="7s"
              values="0.012 0.026; 0.018 0.018; 0.010 0.032; 0.012 0.026"
              repeatCount="indefinite"
            />
          </feTurbulence>
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>

      {ripples.map((ripple) => (
        <span
          className="cursor-ripple"
          key={ripple.id}
          style={{ "--x": `${ripple.x}px`, "--y": `${ripple.y}px` } as CssVars}
        />
      ))}

      <section className="stage">
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

          <button
            className="restore-command"
            type="button"
            onClick={handleRestore}
            disabled={!canRestore || phase === "restoring"}
          >
            复原
          </button>
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

export default App;
