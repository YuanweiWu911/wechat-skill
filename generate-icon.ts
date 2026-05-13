#!/usr/bin/env bun
// generate-icon.ts — Multi-resolution .ico generator for system tray.
// Generates 32, 48, 64, 96, 128 px sizes with 8x supersampling.
// Run: bun run generate-icon.ts

import { writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const PROJ = resolve(dirname(process.argv[1]));
const OUT = join(PROJ, ".claude", "hooks", "wechat-tray.ico");
const ICON_SIZES = [32, 48, 64, 96, 128];

function w16(buf: Buffer, off: number, v: number) { buf.writeUInt16LE(v, off); }
function w32(buf: Buffer, off: number, v: number) { buf.writeUInt32LE(v, off); }

// ── Render at high internal resolution (256px) ──────────
const HR = 256;
const hc = HR / 2, hr = HR * 0.43;

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

function pointToSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, ax + t * dx, ay + t * dy);
}

// W letter segments (in normalized -1..1 space, scaled to hr)
const wSegs = [
  { ax: -0.62, ay: -0.68, bx: -0.30, by: 0.62 },  // left arm
  { ax: -0.30, ay: 0.62, bx: 0.00, by: -0.28 },    // left inner
  { ax: 0.00, ay: -0.28, bx: 0.30, by: 0.62 },     // right inner
  { ax: 0.30, ay: 0.62, bx: 0.62, by: -0.68 },     // right arm
];

const W_THICK = 0.19; // normalized thickness

function isWLetter(nx: number, ny: number): number {
  // Returns 0..1 coverage
  let minDist = 999;
  for (const s of wSegs) {
    const d = pointToSegDist(nx, ny, s.ax, s.ay, s.bx, s.by);
    if (d < minDist) minDist = d;
  }
  if (minDist > W_THICK) return 0;
  return Math.min(1, (W_THICK - minDist) / 0.04);
}

function samplePixel(nx: number, ny: number): [number, number, number, number] {
  const d = dist(nx, ny, 0, 0);
  const nr = hr / (HR / 2);

  // Outside circle
  if (d > nr + 0.02) return [0, 0, 0, 0];

  // Circle edge smoothing
  const edge = Math.min(1, Math.max(0, (nr + 0.02 - d) / 0.04));
  const alpha = Math.round(edge * 255);

  // Background gradient: teal-dark
  const norm = d / nr;
  const bgR = Math.round(10 + norm * 12);
  const bgG = Math.round(18 + norm * 20);
  const bgB = Math.round(28 + norm * 25);

  // Outer glow ring
  const glowR = nr * 0.98;
  const glow = Math.max(0, 1 - Math.abs(d - glowR) / 0.04);
  const glowAlpha = Math.round(glow * 60);

  // W letter
  const wCover = isWLetter(nx, ny);

  if (wCover > 0) {
    // Teal W with slight glow
    const wa = Math.round(Math.min(255, wCover * alpha + glowAlpha * 0.3));
    return [205, 220, 50, wa]; // BGRA
  }

  // Background with glow
  const finalA = Math.min(255, alpha + glowAlpha);
  return [bgB, bgG, bgR, finalA];
}

function renderSize(size: number): Buffer {
  const scale = size / HR;
  const ss = 4; // 4x supersampling per axis = 16 samples per pixel
  const stride = size * 4;
  const data = Buffer.alloc(stride * size, 0);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let accR = 0, accG = 0, accB = 0, accA = 0, count = 0;

      // Supersampling grid
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const fx = (px + (sx + 0.5) / ss) / scale;
          const fy = (py + (sy + 0.5) / ss) / scale;
          const nx = (fx - HR / 2) / hr;
          const ny = (fy - HR / 2) / hr;

          const [b, g, r, a] = samplePixel(nx, ny);
          accR += r * a;
          accG += g * a;
          accB += b * a;
          accA += a;
          count++;
        }
      }

      // Alpha-premultiplied blending
      const avgA = Math.round(accA / count);
      const i = ((size - 1 - py) * size + px) * 4; // bottom-up for BMP

      if (avgA === 0) {
        data[i + 3] = 0;
      } else {
        data[i] = Math.round(Math.min(255, accB / count));       // B
        data[i + 1] = Math.round(Math.min(255, accG / count));   // G
        data[i + 2] = Math.round(Math.min(255, accR / count));   // R
        data[i + 3] = Math.min(255, avgA);
      }
    }
  }
  return data;
}

// ── Build multi-resolution ICO ──────────────────────────
const ICO_HDR = 6;
const DIR_ENTRY = 16;
const BMP_HDR = 40;
const count = ICON_SIZES.length;

// Calculate offsets
const entries: { size: number; dataOff: number; dataLen: number; pixelData: Buffer }[] = [];
let currentOff = ICO_HDR + DIR_ENTRY * count;

for (const size of ICON_SIZES) {
  const pixelData = renderSize(size);
  const dataLen = BMP_HDR + pixelData.length;
  entries.push({ size, dataOff: currentOff, dataLen, pixelData });
  currentOff += dataLen;
}

const totalLen = currentOff;
const buf = Buffer.alloc(totalLen, 0);

// ICO header
w16(buf, 0, 0);
w16(buf, 2, 1);
w16(buf, 4, count);

// Directory entries + BMP data
for (let i = 0; i < count; i++) {
  const e = entries[i];
  const off = ICO_HDR + i * DIR_ENTRY;

  buf[off] = e.size >= 256 ? 0 : e.size;
  buf[off + 1] = e.size >= 256 ? 0 : e.size;
  buf[off + 2] = 0;
  buf[off + 3] = 0;
  w16(buf, off + 4, 1);     // planes
  w16(buf, off + 6, 32);    // bpp
  w32(buf, off + 8, e.dataLen);
  w32(buf, off + 12, e.dataOff);

  // BITMAPINFOHEADER
  const bmpOff = e.dataOff;
  w32(buf, bmpOff, BMP_HDR);
  w32(buf, bmpOff + 4, e.size);
  w32(buf, bmpOff + 8, e.size * 2);
  w16(buf, bmpOff + 12, 1);
  w16(buf, bmpOff + 14, 32);
  w32(buf, bmpOff + 16, 0);

  // Pixel data
  e.pixelData.copy(buf, bmpOff + BMP_HDR);
}

writeFileSync(OUT, buf);

const sizes = ICON_SIZES.map(s => `${s}x${s}`).join(", ");
console.log(`Icon created: ${OUT}`);
console.log(`Sizes: ${sizes}`);
console.log(`Total: ${buf.length} bytes`);
