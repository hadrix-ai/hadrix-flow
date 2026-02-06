import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(projectRoot, "dist");

mkdirSync(distDir, { recursive: true });
copyFileSync(join(projectRoot, "src", "cli.ts"), join(distDir, "cli.ts"));

process.stdout.write("Built stub artifacts into dist/ (TypeScript copied; compilation not wired yet).\n");

