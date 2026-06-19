/**
 * Copy dist/ into the game's mods folder as a fresh version of the mod.
 * Runs automatically after `build` via the `postbuild` npm script.
 */

import { existsSync, mkdirSync, rmSync, cpSync, lstatSync, readFileSync } from 'fs';
import { join } from 'path';

const platform = process.platform;

// Mods folder paths by platform
const MODS_PATHS: Record<string, string> = {
  darwin: `${process.env.HOME}/Library/Application Support/metro-maker4/mods`,
  win32: `${process.env.APPDATA}\\metro-maker4\\mods`,
  linux: `${process.env.HOME}/.config/metro-maker4/mods`,
};

function getModId(): string {
  const manifestPath = join(process.cwd(), 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const parts = manifest.id?.split('.') || [];
      return parts[parts.length - 1] || 'my-mod';
    } catch {
      // Fall back to default
    }
  }
  return 'my-mod';
}

const modsPath = MODS_PATHS[platform];
if (!modsPath) {
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

const distPath = join(process.cwd(), 'dist');
const modId = getModId();
const targetPath = join(modsPath, modId);

if (!existsSync(distPath)) {
  console.error(`dist/ folder not found. Run the build first.`);
  process.exit(1);
}

if (!existsSync(modsPath)) {
  mkdirSync(modsPath, { recursive: true });
}

// Replace any existing install (folder or symlink) with a fresh copy.
if (existsSync(targetPath)) {
  const stats = lstatSync(targetPath);
  rmSync(targetPath, { recursive: true, force: true });
  if (stats.isSymbolicLink()) {
    console.log(`Replaced existing symlink at ${targetPath} with a copy.`);
  }
}

cpSync(distPath, targetPath, { recursive: true });
console.log(`Installed mod to: ${targetPath}`);
