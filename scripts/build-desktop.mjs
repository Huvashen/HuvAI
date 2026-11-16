import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

await mkdir('dist/desktop', { recursive: true });
await build({ entryPoints: ['apps/desktop/src/main/main.ts'], outfile: 'dist/desktop/main.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'node:*'] });
await build({ entryPoints: ['apps/desktop/src/preload/preload.ts'], outfile: 'dist/desktop/preload.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] });

// Original small PNG tray mark: a white J on a blue circle. No external asset dependency.
function crc(bytes) { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); }
const pixels = Buffer.alloc(32 * (1 + 32 * 4));
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const i = y * 129 + 1 + x * 4; const inside = (x - 15.5) ** 2 + (y - 15.5) ** 2 < 225;
  const letter = (y >= 8 && y <= 11 && x >= 10 && x <= 23) || (x >= 18 && x <= 21 && y >= 10 && y <= 21)
    || (y >= 20 && y <= 24 && x >= 9 && x <= 20) || (x >= 8 && x <= 11 && y >= 18 && y <= 22);
  pixels[i] = letter ? 255 : 39; pixels[i + 1] = letter ? 255 : 114; pixels[i + 2] = letter ? 255 : 238; pixels[i + 3] = inside ? 255 : 0;
}
const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6;
await writeFile('dist/desktop/icon.png', Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
