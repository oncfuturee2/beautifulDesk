import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const modelDir = path.join(projectRoot, "model");

function modelContentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".fbx") return "application/octet-stream";

  return "application/octet-stream";
}

function toModelUrl(filePath: string) {
  return `/model/${path.relative(modelDir, filePath).split(path.sep).join("/")}`;
}

function findFirstByExtension(directory: string, extension: string): string | null {
  if (!fs.existsSync(directory)) {
    return null;
  }

  const entries = fs.readdirSync(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isFile() && path.extname(entry.name).toLowerCase() === extension) {
      return entryPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const foundPath = findFirstByExtension(path.join(directory, entry.name), extension);
    if (foundPath) {
      return foundPath;
    }
  }

  return null;
}

function discoverModelAssets() {
  if (!fs.existsSync(modelDir)) {
    return [];
  }

  return fs
    .readdirSync(modelDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const assetDir = path.join(modelDir, entry.name);
      const preferredSourceDir = path.join(assetDir, "source");
      const fbxPath =
        findFirstByExtension(preferredSourceDir, ".fbx") ??
        findFirstByExtension(assetDir, ".fbx");

      if (!fbxPath) {
        return [];
      }

      const textureDir = path.join(assetDir, "textures");
      const resourcePath = fs.existsSync(textureDir)
        ? `${toModelUrl(textureDir)}/`
        : `${toModelUrl(path.dirname(fbxPath))}/`;

      return [
        {
          name: entry.name,
          url: toModelUrl(fbxPath),
          resourcePath,
          collider: [0.46, 0.54, 0.36],
          visualHeight: 1.16,
        },
      ];
    });
}

function safeModelPath(url = "") {
  const pathname = decodeURIComponent(url.split("?")[0] ?? "");
  const relativePath = path
    .normalize(pathname)
    .replace(/^(\.\.(\/|\\|$))+/, "")
    .replace(/^(\/|\\)+/, "");
  const resolvedPath = path.resolve(modelDir, relativePath);
  const resolvedModelDir = path.resolve(modelDir);

  if (resolvedPath !== resolvedModelDir && !resolvedPath.startsWith(resolvedModelDir + path.sep)) {
    return null;
  }

  return resolvedPath;
}

function modelAssetsModulePlugin(): Plugin {
  const virtualId = "virtual:beautifuldesk-models";
  const resolvedVirtualId = `\0${virtualId}`;

  return {
    name: "beautifuldesk-model-assets-module",
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : null;
    },
    load(id) {
      if (id !== resolvedVirtualId) {
        return null;
      }

      return `export default ${JSON.stringify(discoverModelAssets(), null, 2)};`;
    },
    configureServer(server) {
      if (fs.existsSync(modelDir)) {
        server.watcher.add(modelDir);
      }
    },
  };
}

function modelAssetsPlugin(): Plugin {
  return {
    name: "beautifuldesk-model-assets",
    configureServer(server) {
      server.middlewares.use("/model", (req, res, next) => {
        const filePath = safeModelPath(req.url);

        if (!filePath) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        fs.stat(filePath, (error, stat) => {
          if (error || !stat.isFile()) {
            next();
            return;
          }

          res.setHeader("Content-Type", modelContentType(filePath));
          fs.createReadStream(filePath).pipe(res);
        });
      });
    },
    closeBundle() {
      if (!fs.existsSync(modelDir)) {
        return;
      }

      const distModelDir = path.join(projectRoot, "dist", "model");
      fs.rmSync(distModelDir, { recursive: true, force: true });
      fs.cpSync(modelDir, distModelDir, { recursive: true });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), modelAssetsModulePlugin(), modelAssetsPlugin()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
