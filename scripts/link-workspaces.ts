/**
 * Ensures @pizzapi/* workspace symlinks exist in node_modules.
 * Bun sometimes fails to create symlinks for scoped workspace packages.
 * Runs as postinstall to guarantee they're always present.
 */
import { mkdirSync, symlinkSync, readlinkSync, lstatSync, rmSync } from "fs";
import { join, resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const scope = join(root, "node_modules", "@pizzapi");
const packages = ["cli", "docs", "protocol", "server", "tools", "ui"];

mkdirSync(scope, { recursive: true });

for (const pkg of packages) {
  const link = join(scope, pkg);
  const target = join(root, "packages", pkg);

  // Check if the link already points to the correct target
  try {
    const existing = readlinkSync(link);
    if (resolve(scope, existing) === target) continue;
    // Symlink exists but points to the wrong target — remove it
    rmSync(link, { recursive: true, force: true });
  } catch {
    // readlinkSync failed — path might be a real directory/file or not exist.
    // If something exists at the path, remove it so we can create the symlink.
    try {
      lstatSync(link);
      rmSync(link, { recursive: true, force: true });
    } catch {
      // Nothing exists at the path — good, we can create the symlink
    }
  }

  try {
    symlinkSync(target, link);
  } catch (err) {
    console.error(`[link-workspaces] Failed to symlink ${pkg}: ${(err as Error).message}`);
  }
}
