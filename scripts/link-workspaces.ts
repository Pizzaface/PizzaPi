/**
 * Ensures @pizzapi/* workspace symlinks exist in node_modules.
 * Bun sometimes fails to create symlinks for scoped workspace packages.
 * Runs as postinstall to guarantee they're always present.
 */
import { mkdirSync, symlinkSync, readlinkSync } from "fs";
import { join, resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const scope = join(root, "node_modules", "@pizzapi");
const packages = ["cli", "docs", "protocol", "server", "tools", "ui"];

mkdirSync(scope, { recursive: true });

for (const pkg of packages) {
  const link = join(scope, pkg);
  const target = join(root, "packages", pkg);

  try {
    const existing = readlinkSync(link);
    if (resolve(scope, existing) === target) continue;
  } catch {}

  try {
    symlinkSync(target, link);
  } catch {}
}
