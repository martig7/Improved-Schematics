/** Single source of truth for the mod version. Bump it HERE, then build:
 *  vite.config.ts syncs this value into manifest.json + package.json (their `version`
 *  fields, which JSON can't import from TS), and main.ts logs it on startup. */
export const MOD_VERSION = '2.0.0';
