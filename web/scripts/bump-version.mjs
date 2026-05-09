// Bump APP_VERSION in src/lib/version.ts and the matching VERSION constant
// in public/sw.js. Run via `pnpm run version:bump [patch|minor|major]`
// (default: patch).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const kind = process.argv[2] || "patch";
if (!["patch", "minor", "major"].includes(kind)) {
  console.error(`unknown bump kind: ${kind} (expected patch|minor|major)`);
  process.exit(1);
}

const versionPath = resolve(root, "src/lib/version.ts");
const swPath = resolve(root, "public/sw.js");

const versionSrc = readFileSync(versionPath, "utf8");
const m = versionSrc.match(/APP_VERSION\s*=\s*["']([^"']+)["']/);
if (!m) {
  console.error("could not find APP_VERSION in src/lib/version.ts");
  process.exit(1);
}
const [a, b, c] = m[1].split(".").map((n) => Number(n));
const next =
  kind === "major" ? `${a + 1}.0.0` : kind === "minor" ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;

writeFileSync(versionPath, versionSrc.replace(m[0], `APP_VERSION = "${next}"`));

const swSrc = readFileSync(swPath, "utf8");
const swNext = swSrc.replace(/const VERSION = ['"][^'"]+['"]/, `const VERSION = 'v${next}'`);
if (swNext === swSrc) {
  console.error("could not find VERSION line in public/sw.js");
  process.exit(1);
}
writeFileSync(swPath, swNext);

console.log(`${m[1]} -> ${next}`);
