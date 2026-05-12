#!/usr/bin/env node
// Render apps/web/public/og.svg → apps/web/public/og.png at 1200×630.
// Run after editing the SVG: `node scripts/render-og.mjs`.
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const svg = path.join(root, "apps/web/public/og.svg");
const png = path.join(root, "apps/web/public/og.png");

const info = await sharp(svg, { density: 300 })
  .resize(1200, 630)
  .png({ compressionLevel: 9 })
  .toFile(png);

console.log(`og.png: ${(info.size / 1024).toFixed(1)} KB`);
