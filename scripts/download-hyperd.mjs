#!/usr/bin/env node
/**
 * Bootstrap the `hyperd` server binary for reading extract (.hyper) data.
 *
 * The `.twbx` upload already contains the `.hyper` DATA, but querying it needs the
 * Hyper query ENGINE (`hyperd`), a native binary that is NOT shipped in the TWBX or
 * the npm package. On your dev Mac it is auto-detected from Tableau Desktop, but on a
 * clean server / container there is no Tableau install - so we download the official,
 * pinned `hyperd` from Tableau's Hyper API package and place it in `./.hyperd/hyper/`.
 * The reader (src/tableau/data/hyperReader.ts) looks there automatically; no env var
 * is required once this has run (set HYPERD_PATH only to override).
 *
 * Usage:
 *   node scripts/download-hyperd.mjs                 # pinned release, current platform
 *   node scripts/download-hyperd.mjs --version 0.0.24457 --build-id rc36858b6
 *   HYPERD_VERSION=0.0.24457 HYPERD_BUILD_ID=rc36858b6 node scripts/download-hyperd.mjs
 *
 * Browse releases (version + build id) at:
 *   https://tableau.github.io/hyper-db/docs/releases
 */

import { mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://downloads.tableau.com/tssoftware";

// Pinned release. `hyperd` is protocol-compatible across nearby releases; bump these
// (or pass --version/--build-id) if Tableau yanks/renames the archive.
const DEFAULT_VERSION = "0.0.24457";
const DEFAULT_BUILD_ID = "rc36858b6";

/** Maps Node's platform/arch to Tableau's Hyper API package slug. */
function platformSlug() {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x86_64";
  if (platform === "linux" && arch === "x64") return "linux-x86_64";
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  throw new Error(
    `Unsupported platform ${platform}/${arch}. Supported: macOS arm64/x64, ` +
      `Linux x64, Windows x64. Provide a hyperd binary manually and set HYPERD_PATH.`,
  );
}

/** Parses `--flag value` pairs from argv. */
function argFlag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const version = argFlag("version") ?? process.env.HYPERD_VERSION ?? DEFAULT_VERSION;
  const buildId = argFlag("build-id") ?? process.env.HYPERD_BUILD_ID ?? DEFAULT_BUILD_ID;
  const slug = platformSlug();
  const exe = process.platform === "win32" ? "hyperd.exe" : "hyperd";

  const destRoot = join(PROJECT_ROOT, ".hyperd");
  const destHyperDir = join(destRoot, "hyper");
  const finalPath = join(destHyperDir, exe);

  if (existsSync(finalPath) && !process.argv.includes("--force")) {
    console.log(`hyperd already present: ${finalPath}`);
    console.log("Re-run with --force to re-download.");
    return;
  }

  const url =
    `${BASE_URL}/tableauhyperapi-java-${slug}-release-main.${version}.${buildId}.zip`;
  console.log(`Platform : ${slug}`);
  console.log(`Release  : ${version}.${buildId}`);
  console.log(`Download : ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Download failed (HTTP ${res.status}). The pinned release may have been ` +
        `renamed/removed. Pick a current version+build id from ` +
        `https://tableau.github.io/hyper-db/docs/releases and pass ` +
        `--version <v> --build-id <b>.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`Fetched  : ${(buf.length / 1_048_576).toFixed(1)} MiB, extracting...`);

  const zip = await JSZip.loadAsync(buf);
  await rm(destHyperDir, { recursive: true, force: true });
  await mkdir(destHyperDir, { recursive: true });

  // Extract everything under `.../lib/hyper/` into `.hyperd/hyper/`, preserving the
  // internal layout (hyperd needs its sibling `hyperdstarter` and resource files).
  let extracted = 0;
  const entries = Object.values(zip.files);
  for (const entry of entries) {
    const m = /(?:^|\/)lib\/hyper\/(.+)$/.exec(entry.name);
    if (!m) continue;
    const rel = m[1];
    const outPath = join(destHyperDir, rel);
    if (entry.dir || rel.endsWith("/")) {
      await mkdir(outPath, { recursive: true });
      continue;
    }
    await mkdir(dirname(outPath), { recursive: true });
    const data = await entry.async("nodebuffer");
    await writeFile(outPath, data);
    // Make binaries/executables runnable (hyperd, hyperdstarter, helpers).
    await chmod(outPath, 0o755);
    extracted += 1;
  }

  if (!existsSync(finalPath)) {
    throw new Error(
      `Archive did not contain lib/hyper/${exe}. Extracted ${extracted} files to ` +
        `${destHyperDir}. The package layout may have changed.`,
    );
  }

  console.log(`Extracted: ${extracted} files`);
  console.log(`\n✅ hyperd ready: ${finalPath}`);
  console.log(
    "The app auto-detects this path. (Optionally set HYPERD_PATH to it to be explicit.)",
  );
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
