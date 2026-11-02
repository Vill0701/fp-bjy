// Salin PDF.js dari node_modules ke vendor/ untuk dipakai browser.
// Jalankan ulang (npm run vendor) setelah memperbarui pdfjs-dist.
import { copyFileSync, mkdirSync } from "node:fs";

const from = new URL("../node_modules/pdfjs-dist/", import.meta.url);
const to = new URL("../vendor/pdfjs/", import.meta.url);
mkdirSync(to, { recursive: true });
for (const [source, target] of [
  ["legacy/build/pdf.min.mjs", "pdf.min.js"],
  ["legacy/build/pdf.worker.min.mjs", "pdf.worker.min.js"],
  ["LICENSE", "LICENSE"],
]) {
  copyFileSync(new URL(source, from), new URL(target, to));
}
