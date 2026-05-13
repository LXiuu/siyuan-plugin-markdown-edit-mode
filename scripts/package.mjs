import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import JSZip from "jszip";

const rootDir = process.cwd();
const distDir = join(rootDir, "dist");
const zipPath = join(rootDir, "package.zip");
const zip = new JSZip();

async function addDirectory(directory) {
  const entries = await readdir(directory);

  await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = join(directory, entry);
      const stats = await stat(absolutePath);

      if (stats.isDirectory()) {
        await addDirectory(absolutePath);
        return;
      }

      if (!stats.isFile()) {
        return;
      }

      const zipName = relative(distDir, absolutePath).split(sep).join("/");
      zip.file(zipName, await readFile(absolutePath));
    }),
  );
}

await addDirectory(distDir);

const output = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: {
    level: 9,
  },
});

await writeFile(zipPath, output);
console.log(`Created ${zipPath}`);
