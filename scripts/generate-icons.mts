// Rasterizes scripts/icon.svg into the PWA / favicon set. Run: npm run icons
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const svg = await readFile(new URL("./icon.svg", import.meta.url), "utf8");
const rounded = Buffer.from(svg.replace("ROUND", "22"));
const square = Buffer.from(svg.replace("ROUND", "0")); // maskable + Apple apply their own mask

const out = (p: string) => new URL(`../${p}`, import.meta.url);
const png = (src: Buffer, size: number) => sharp(src, { density: 384 }).resize(size, size).png().toBuffer();

await writeFile(out("public/icons/icon-192.png"), await png(rounded, 192));
await writeFile(out("public/icons/icon-512.png"), await png(rounded, 512));
await writeFile(out("public/icons/maskable-512.png"), await png(square, 512));
await writeFile(out("src/app/apple-icon.png"), await png(square, 180));
await writeFile(out("src/app/icon.svg"), rounded);
console.log("icons written");
