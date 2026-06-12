import { toCanvas } from "html-to-image";
import {
  Application,
  Container,
  DisplacementFilter,
  Sprite,
  Texture,
  type Ticker,
} from "pixi.js";
import { useEffect, useRef, useState, type RefObject } from "react";

type WebGLWaterSurfaceProps = {
  targetRef: RefObject<HTMLElement | null>;
  captureKey: string;
  onReady?: (ready: boolean) => void;
};

type Wake = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  born: number;
  speed: number;
};

const MAP_SIZE = 512;
const MAX_WAKES = 54;

function drawWakeMap(canvas: HTMLCanvasElement, wakes: Wake[], now: number) {
  const ctx = canvas.getContext("2d", { willReadFrequently: false });
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);
  ctx.fillStyle = "rgb(128, 128, 128)";
  ctx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const wake of wakes) {
    const age = now - wake.born;
    const life = 1700;
    const progress = Math.min(1, age / life);
    const alpha = (1 - progress) * Math.min(1, 0.38 + wake.speed * 0.035);
    const radius = 7 + progress * (46 + wake.speed * 2.5);
    const spread = 6 + progress * 18;
    const angle = Math.atan2(wake.dy, wake.dx || 0.001);
    const x = wake.x * MAP_SIZE;
    const y = wake.y * MAP_SIZE;

    ctx.globalCompositeOperation = "source-over";

    for (let ring = 0; ring < 3; ring += 1) {
      const ringRadius = radius + ring * spread;
      const ringAlpha = alpha * (1 - ring * 0.22);
      const red = ring % 2 === 0 ? 178 : 78;
      const green = ring % 2 === 0 ? 78 : 178;

      ctx.strokeStyle = `rgba(${red}, ${green}, 128, ${ringAlpha})`;
      ctx.lineWidth = Math.max(1.2, 3.8 - ring * 0.72);
      ctx.beginPath();
      ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    const wakeLength = 34 + wake.speed * 5 + progress * 46;
    const wing = Math.PI * 0.34;

    for (const side of [-1, 1]) {
      const tailAngle = angle + Math.PI + side * wing;
      const endX = x + Math.cos(tailAngle) * wakeLength;
      const endY = y + Math.sin(tailAngle) * wakeLength;
      const red = side === 1 ? 190 : 70;
      const green = side === 1 ? 86 : 184;

      ctx.strokeStyle = `rgba(${red}, ${green}, 128, ${alpha * 0.78})`;
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(
        x + Math.cos(tailAngle) * wakeLength * 0.42,
        y + Math.sin(tailAngle) * wakeLength * 0.42,
        endX,
        endY,
      );
      ctx.stroke();
    }
  }

  ctx.globalCompositeOperation = "source-over";
}

export default function WebGLWaterSurface({
  targetRef,
  captureKey,
  onReady,
}: WebGLWaterSurfaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const contentRef = useRef<Sprite | null>(null);
  const textureRef = useRef<Texture | null>(null);
  const displacementTextureRef = useRef<Texture | null>(null);
  const wakesRef = useRef<Wake[]>([]);
  const lastPointerRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const lastWakeAtRef = useRef(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onReady?.(ready);
  }, [onReady, ready]);

  useEffect(() => {
    let disposed = false;
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    const wakeCanvas = document.createElement("canvas");
    wakeCanvas.width = MAP_SIZE;
    wakeCanvas.height = MAP_SIZE;
    drawWakeMap(wakeCanvas, [], performance.now());

    const setup = async () => {
      const app = new Application();
      await app.init({
        resizeTo: host,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 1.5),
        preference: "webgl",
      });

      if (disposed) {
        app.destroy(true);
        return;
      }

      app.canvas.className = "webgl-water-canvas";
      host.appendChild(app.canvas);

      const content = new Sprite(Texture.EMPTY);
      content.width = app.screen.width;
      content.height = app.screen.height;

      const displacementTexture = Texture.from(wakeCanvas);
      const displacementSprite = new Sprite(displacementTexture);
      displacementSprite.width = app.screen.width;
      displacementSprite.height = app.screen.height;

      const filtered = new Container();
      filtered.addChild(content);
      filtered.filters = [
        new DisplacementFilter({
          sprite: displacementSprite,
          scale: { x: 18, y: 22 },
        }),
      ];

      app.stage.addChild(filtered);
      app.stage.addChild(displacementSprite);
      displacementSprite.renderable = false;

      app.ticker.add((ticker: Ticker) => {
        const now = performance.now();
        wakesRef.current = wakesRef.current.filter((wake) => now - wake.born < 1700);
        drawWakeMap(wakeCanvas, wakesRef.current, now);
        displacementTexture.source.update();

        const filter = filtered.filters?.[0];
        if (filter instanceof DisplacementFilter) {
          const energy = wakesRef.current.reduce((sum, wake) => {
            const age = now - wake.born;
            return sum + Math.max(0, 1 - age / 1700) * Math.min(1.8, wake.speed / 14);
          }, 0);
          const pulse = Math.sin(now / 180) * 0.8;
          filter.scale.x = 11 + Math.min(28, energy * 6.5) + pulse;
          filter.scale.y = 15 + Math.min(34, energy * 7.5) - pulse;
        }

        const elapsed = ticker.elapsedMS;
        displacementSprite.rotation += elapsed * 0.00002;
      });

      appRef.current = app;
      contentRef.current = content;
      displacementTextureRef.current = displacementTexture;
    };

    setup();

    return () => {
      disposed = true;
      setReady(false);
      textureRef.current?.destroy(true);
      displacementTextureRef.current?.destroy(true);
      appRef.current?.destroy(true);
      appRef.current = null;
      contentRef.current = null;
      textureRef.current = null;
      displacementTextureRef.current = null;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer = 0;

    const capture = async () => {
      const target = targetRef.current;
      const content = contentRef.current;
      const app = appRef.current;

      if (!target || !content || !app) {
        timer = window.setTimeout(capture, 120);
        return;
      }

      try {
        const canvas = await toCanvas(target, {
          cacheBust: true,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
          backgroundColor: "transparent",
          style: {
            opacity: "1",
            filter: "none",
          },
        });

        if (disposed) {
          return;
        }

        const nextTexture = Texture.from(canvas);
        const previousTexture = textureRef.current;
        textureRef.current = nextTexture;
        content.texture = nextTexture;
        content.width = app.screen.width;
        content.height = app.screen.height;
        previousTexture?.destroy(true);
        setReady(true);
      } catch {
        if (!disposed) {
          setReady(false);
        }
      }
    };

    capture();
    const interval = window.setInterval(capture, 360);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [captureKey, targetRef]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const now = performance.now();
      if (now - lastWakeAtRef.current < 22) {
        return;
      }

      const target = targetRef.current;
      if (!target) {
        return;
      }

      const rect = target.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        return;
      }

      const x = (event.clientX - rect.left) / Math.max(1, rect.width);
      const y = (event.clientY - rect.top) / Math.max(1, rect.height);
      const last = lastPointerRef.current;
      const dx = last ? event.clientX - last.x : 1;
      const dy = last ? event.clientY - last.y : 0;
      const dt = last ? Math.max(16, now - last.time) : 16;
      const speed = Math.min(28, Math.hypot(dx, dy) / (dt / 16));

      lastPointerRef.current = { x: event.clientX, y: event.clientY, time: now };
      lastWakeAtRef.current = now;
      wakesRef.current = [
        ...wakesRef.current.slice(-(MAX_WAKES - 1)),
        { x, y, dx, dy, born: now, speed },
      ];
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
    };
  }, [targetRef]);

  return <div ref={hostRef} className="webgl-water-surface" aria-hidden="true" />;
}
