import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  CuboidCollider,
  Physics,
  RigidBody,
  type RapierRigidBody,
} from "@react-three/rapier";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import discoveredModelAssets from "virtual:beautifuldesk-models";
import {
  callBackend,
  isTauriRuntime,
  previewWallpaperMetrics,
  type WallpaperClick,
  type WallpaperMetrics,
} from "./backend";

const WORLD_SCALE = 86;
const MAX_ASSETS = 42;

type ModelAsset = {
  name: string;
  url: string;
  resourcePath: string;
  collider: [number, number, number];
  visualHeight: number;
};

type SpawnedAsset = {
  id: number;
  modelIndex: number;
  position: [number, number, number];
  rotation: [number, number, number];
  impulse: [number, number, number];
  torque: [number, number, number];
};

const MODEL_ASSETS = discoveredModelAssets as ModelAsset[];

function screenToWorld(x: number, y: number, metrics: WallpaperMetrics): [number, number, number] {
  return [
    (x - metrics.width / 2) / WORLD_SCALE,
    (metrics.height / 2 - y) / WORLD_SCALE,
    (Math.random() - 0.5) * 0.3,
  ];
}

function groundWorldY(metrics: WallpaperMetrics) {
  return (metrics.height / 2 - metrics.ground_y) / WORLD_SCALE;
}

function fitObject(object: THREE.Object3D, targetHeight: number) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const scale = targetHeight / Math.max(size.x, size.y, size.z, 1);

  return {
    scale,
    position: [-center.x * scale, -center.y * scale, -center.z * scale] as [
      number,
      number,
      number,
    ],
  };
}

function markSpawn(object: THREE.Object3D, spawnId: number) {
  object.traverse((child) => {
    child.userData.spawnId = spawnId;
  });
}

function findSpawnId(object: THREE.Object3D | null) {
  let current: THREE.Object3D | null = object;

  while (current) {
    if (typeof current.userData.spawnId === "number") {
      return current.userData.spawnId as number;
    }

    current = current.parent;
  }

  return null;
}

function brightenMaterials(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }

    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) {
        continue;
      }

      material.side = THREE.DoubleSide;

      const textured = material as THREE.MeshStandardMaterial & {
        map?: THREE.Texture | null;
        emissive?: THREE.Color;
        emissiveIntensity?: number;
        envMapIntensity?: number;
      };

      if (textured.map) {
        textured.map.colorSpace = THREE.SRGBColorSpace;
        textured.map.needsUpdate = true;
      }

      if ("envMapIntensity" in textured) {
        textured.envMapIntensity = 1.4;
      }

      if (textured.emissive) {
        textured.emissive = new THREE.Color(0x111111);
        textured.emissiveIntensity = 0.18;
      }

      material.needsUpdate = true;
    }
  });
}

function ModelVisual({
  asset,
  spawnId,
  playSignal,
}: {
  asset: ModelAsset;
  spawnId: number;
  playSignal: number;
}) {
  const source = useLoader(FBXLoader, asset.url, (loader) => {
    loader.setResourcePath(asset.resourcePath);
  });
  const fit = useMemo(() => fitObject(source, asset.visualHeight), [asset.visualHeight, source]);
  const object = useMemo(() => {
    const cloned = SkeletonUtils.clone(source);
    brightenMaterials(cloned);
    markSpawn(cloned, spawnId);
    return cloned;
  }, [source, spawnId]);
  const mixer = useMemo(() => new THREE.AnimationMixer(object), [object]);

  useFrame((_, delta) => {
    mixer.update(delta);
  });

  useEffect(() => {
    if (playSignal <= 0 || source.animations.length === 0) {
      return undefined;
    }

    const action = mixer.clipAction(source.animations[0], object);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = false;
    action.fadeIn(0.04);
    action.play();

    return () => {
      action.fadeOut(0.08);
    };
  }, [mixer, object, playSignal, source.animations]);

  useEffect(
    () => () => {
      mixer.stopAllAction();
    },
    [mixer],
  );

  return (
    <group position={fit.position} scale={fit.scale} userData={{ spawnId }}>
      <primitive object={object} />
    </group>
  );
}

function FallbackModel({ asset, spawnId }: { asset: ModelAsset; spawnId: number }) {
  return (
    <mesh
      scale={[asset.collider[0] * 1.5, asset.collider[1] * 1.5, asset.collider[2] * 1.5]}
      userData={{ spawnId }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#5eead4" roughness={0.48} metalness={0.04} />
    </mesh>
  );
}

function FallingModel({
  spawn,
  playSignal,
}: {
  spawn: SpawnedAsset;
  playSignal: number;
}) {
  const asset = MODEL_ASSETS[spawn.modelIndex];
  const body = useRef<RapierRigidBody>(null);

  useEffect(() => {
    const rigidBody = body.current;
    if (!rigidBody) {
      return;
    }

    rigidBody.applyImpulse(
      { x: spawn.impulse[0], y: spawn.impulse[1], z: spawn.impulse[2] },
      true,
    );
    rigidBody.applyTorqueImpulse(
      { x: spawn.torque[0], y: spawn.torque[1], z: spawn.torque[2] },
      true,
    );
  }, [spawn.impulse, spawn.torque]);

  useEffect(() => {
    if (playSignal <= 0) {
      return;
    }

    const rigidBody = body.current;
    rigidBody?.wakeUp();
    rigidBody?.applyImpulse({ x: 0, y: 0.22, z: 0 }, true);
    rigidBody?.applyTorqueImpulse({ x: 0.15, y: 0.18, z: -0.12 }, true);
  }, [playSignal]);

  if (!asset) {
    return null;
  }

  return (
    <RigidBody
      ref={body}
      colliders={false}
      position={spawn.position}
      rotation={spawn.rotation}
      restitution={0.24}
      friction={0.86}
      linearDamping={0.18}
      angularDamping={0.28}
      canSleep
    >
      <CuboidCollider args={asset.collider} />
      <group userData={{ spawnId: spawn.id }}>
        <Suspense fallback={<FallbackModel asset={asset} spawnId={spawn.id} />}>
          <ModelVisual asset={asset} spawnId={spawn.id} playSignal={playSignal} />
        </Suspense>
      </group>
    </RigidBody>
  );
}

function WorldBounds({ metrics }: { metrics: WallpaperMetrics }) {
  const width = metrics.width / WORLD_SCALE;
  const height = metrics.height / WORLD_SCALE;
  const floorY = groundWorldY(metrics);

  return (
    <>
      <RigidBody type="fixed" colliders={false} position={[0, floorY - 0.08, 0]}>
        <CuboidCollider args={[width / 2 + 2, 0.08, 4]} />
      </RigidBody>
      <RigidBody type="fixed" colliders={false} position={[-width / 2 - 0.08, 0, 0]}>
        <CuboidCollider args={[0.08, height, 4]} />
      </RigidBody>
      <RigidBody type="fixed" colliders={false} position={[width / 2 + 0.08, 0, 0]}>
        <CuboidCollider args={[0.08, height, 4]} />
      </RigidBody>
    </>
  );
}

function DesktopClickResolver({
  click,
  metrics,
  onBlankClick,
  onModelClick,
}: {
  click: WallpaperClick | null;
  metrics: WallpaperMetrics;
  onBlankClick: (click: WallpaperClick) => void;
  onModelClick: (spawnId: number) => void;
}) {
  const { camera, raycaster, scene } = useThree();
  const handledClick = useRef(0);

  useEffect(() => {
    if (!click || handledClick.current === click.id) {
      return;
    }

    handledClick.current = click.id;
    const pointer = new THREE.Vector2(
      (click.x / Math.max(1, metrics.width)) * 2 - 1,
      -(click.y / Math.max(1, metrics.height)) * 2 + 1,
    );

    raycaster.setFromCamera(pointer, camera);
    const intersections = raycaster.intersectObjects(scene.children, true);

    for (const intersection of intersections) {
      const spawnId = findSpawnId(intersection.object);
      if (spawnId !== null) {
        onModelClick(spawnId);
        return;
      }
    }

    onBlankClick(click);
  }, [camera, click, metrics.height, metrics.width, onBlankClick, onModelClick, raycaster, scene]);

  return null;
}

export default function WallpaperWindow() {
  const [metrics, setMetrics] = useState<WallpaperMetrics>(() => previewWallpaperMetrics());
  const [spawns, setSpawns] = useState<SpawnedAsset[]>([]);
  const [pendingClick, setPendingClick] = useState<WallpaperClick | null>(null);
  const [playSignals, setPlaySignals] = useState<Record<number, number>>({});
  const metricsRef = useRef(metrics);
  const nextModel = useRef(0);
  const fallbackClickId = useRef(0);

  const spawnAt = useCallback((click: WallpaperClick) => {
    if (MODEL_ASSETS.length === 0) {
      return;
    }

    const currentMetrics = metricsRef.current;
    const modelIndex = nextModel.current % MODEL_ASSETS.length;
    nextModel.current += 1;

    const drift = (Math.random() - 0.5) * 0.55;
    const spawn: SpawnedAsset = {
      id: click.id,
      modelIndex,
      position: screenToWorld(click.x, click.y, currentMetrics),
      rotation: [
        (Math.random() - 0.5) * 0.35,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 0.28,
      ],
      impulse: [drift, 0.2 + Math.random() * 0.28, (Math.random() - 0.5) * 0.18],
      torque: [
        (Math.random() - 0.5) * 0.9,
        (Math.random() - 0.5) * 1.1,
        (Math.random() - 0.5) * 1.4,
      ],
    };

    setSpawns((current) => [...current.slice(-(MAX_ASSETS - 1)), spawn]);
  }, []);

  const playModel = useCallback((spawnId: number) => {
    setPlaySignals((current) => ({
      ...current,
      [spawnId]: (current[spawnId] ?? 0) + 1,
    }));
  }, []);

  useEffect(() => {
    metricsRef.current = metrics;
  }, [metrics]);

  useEffect(() => {
    document.documentElement.dataset.view = "wallpaper";

    return () => {
      delete document.documentElement.dataset.view;
    };
  }, []);

  useEffect(() => {
    let disposed = false;

    const refreshMetrics = async () => {
      try {
        const nextMetrics = await callBackend<WallpaperMetrics>("wallpaper_status");
        if (!disposed) {
          setMetrics(nextMetrics);
        }
      } catch {
        if (!disposed) {
          setMetrics(previewWallpaperMetrics());
        }
      }
    };

    refreshMetrics();

    const handleResize = () => {
      if (!isTauriRuntime()) {
        setMetrics(previewWallpaperMetrics());
      }
    };

    window.addEventListener("resize", handleResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let busy = false;

    const timer = window.setInterval(async () => {
      if (busy) {
        return;
      }

      busy = true;

      try {
        const click = await callBackend<WallpaperClick | null>("poll_wallpaper_click");
        if (!disposed && click) {
          setPendingClick(click);
        }
      } finally {
        busy = false;
      }
    }, 34);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const handlePreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isTauriRuntime()) {
      return;
    }

    fallbackClickId.current += 1;
    setPendingClick({
      id: fallbackClickId.current,
      x: event.clientX,
      y: event.clientY,
    });
  };

  return (
    <main
      className="wallpaper-window"
      aria-label="BeautifulDesk 壁纸窗口"
      onPointerDown={handlePreviewPointerDown}
    >
      <Canvas
        orthographic
        camera={{ position: [0, 0, 60], zoom: WORLD_SCALE, near: 0.1, far: 200 }}
        dpr={[1, 1.5]}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.55;
        }}
      >
        <ambientLight intensity={2.6} />
        <hemisphereLight args={["#fff6e6", "#9db9ff", 2.35]} />
        <directionalLight position={[3, 7, 8]} intensity={3.2} color="#fff3dd" />
        <directionalLight position={[-5, 3, 6]} intensity={1.45} color="#b8ddff" />
        <directionalLight position={[0, 2, -7]} intensity={0.85} color="#ffffff" />
        <Physics gravity={[0, -18, 0]} timeStep="vary">
          <WorldBounds metrics={metrics} />
          <DesktopClickResolver
            click={pendingClick}
            metrics={metrics}
            onBlankClick={spawnAt}
            onModelClick={playModel}
          />
          {spawns.map((spawn) => (
            <FallingModel
              key={spawn.id}
              spawn={spawn}
              playSignal={playSignals[spawn.id] ?? 0}
            />
          ))}
        </Physics>
      </Canvas>
    </main>
  );
}
