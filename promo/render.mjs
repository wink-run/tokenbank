// Render video.html frame-by-frame and encode to MP4.
//   node render.mjs            -> out/tokenbank-promo.mp4 (needs out/soundtrack.wav, see soundtrack.py)
//   node render.mjs --stills   -> out/stills/*.png at a few key times
//   LANG_EN=1 node render.mjs  -> English version (video.html?lang=en), out/tokenbank-promo-en.mp4
//   CINE=1 node render.mjs     -> cinematic trailer look (video.html?cine), out/tokenbank-promo-cine.mp4 + out/soundtrack-cine.wav
// Env: FPS (default 30), FFMPEG (default: `ffmpeg` on PATH), CHROMIUM (optional executable path).
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require(path.join(process.execPath, '../../lib/node_modules/playwright'))); }

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });
const FPS = +(process.env.FPS || 30);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const stills = process.argv.includes('--stills');
const en = !!process.env.LANG_EN;
const cine = !!process.env.CINE;
const suffix = (cine ? '-cine' : '') + (en ? '-en' : '');
const query = [en && 'lang=en', cine && 'cine'].filter(Boolean).join('&');

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.join(here, 'video.html')).href + (query ? '?' + query : ''));
await page.evaluate(() => window.ready);
await page.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
const duration = await page.evaluate(() => window.DURATION);
const stage = await page.$('#stage');
const shot = async (t, opts) => { await page.evaluate(t => window.renderFrame(t), t); return stage.screenshot(opts); };

if (stills) {
  const dir = path.join(out, 'stills' + suffix);
  mkdirSync(dir, { recursive: true });
  const times = (process.env.TIMES || '1.6,3.8,4.8,7.9,13.2,15,20,24.6,28.9,34.3,39.8,43.5,50.5').split(',').map(Number);
  for (const t of times) await shot(t, { path: path.join(dir, `t${t.toFixed(1).padStart(5, '0')}.png`) });
  console.log(`wrote ${times.length} stills to ${dir}`);
} else {
  const audio = path.join(out, cine ? 'soundtrack-cine.wav' : 'soundtrack.wav');
  const args = ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-'];
  if (existsSync(audio)) args.push('-i', audio, '-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    path.join(out, `tokenbank-promo${suffix}.mp4`));
  const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(duration * FPS);
  for (let i = 0; i < total; i++) {
    const buf = await shot(i / FPS, { type: 'jpeg', quality: 95 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % FPS === 0) process.stdout.write(`\rframe ${i}/${total}`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log('\ndone');
}
await browser.close();
