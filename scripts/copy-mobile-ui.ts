#!/usr/bin/env bun
/**
 * Copy the built web UI into the mobile workspace so Capacitor bundles it
 * alongside the bootstrap page. The bootstrap page then loads ./app/index.html
 * after the user completes server setup / mobile-link approval.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const source = join(import.meta.dir, "..", "packages", "ui", "dist");
const target = join(import.meta.dir, "..", "mobile", "app");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, dereference: true });

console.log(`Copied UI dist to ${target}`);
