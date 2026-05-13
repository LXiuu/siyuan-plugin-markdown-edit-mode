import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type PluginOption } from "vite";

const rootDir = __dirname;
const distDir = resolve(rootDir, "dist");

function copyPluginAssets(): PluginOption {
  const files = [
    "plugin.json",
    "README.md",
    "README_zh_CN.md",
    "LICENSE",
    "icon.png",
    "preview.png",
  ];

  return {
    name: "copy-siyuan-plugin-assets",
    async closeBundle() {
      await mkdir(distDir, { recursive: true });

      await Promise.all(
        files.map((file) => copyFile(resolve(rootDir, file), resolve(distDir, file))),
      );

      await rm(resolve(distDir, "i18n"), { force: true, recursive: true });
      await cp(resolve(rootDir, "src", "i18n"), resolve(distDir, "i18n"), {
        recursive: true,
      });
    },
  };
}

export default defineConfig({
  build: {
    target: "es2020",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(rootDir, "src", "index.ts"),
      formats: ["cjs"],
      fileName: () => "index.js",
      cssFileName: "index",
    },
    rollupOptions: {
      external: ["siyuan"],
      output: {
        exports: "default",
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith(".css") ? "index.css" : "[name][extname]",
      },
    },
  },
  plugins: [copyPluginAssets()],
});
