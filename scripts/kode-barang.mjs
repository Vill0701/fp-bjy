// Ubah file referensi DJP "ListOfGoods" menjadi src/kode-barang.js (daftar kode barang untuk pencarian).
// Jalankan ulang kalau DJP memperbarui daftarnya: npm run kode-barang [-- path/ke/ListOfGoods.txt]
import { readFileSync, writeFileSync } from "node:fs";
import { parseDelimited } from "../src/csv.js";

const source = process.argv[2] ?? new URL("../contoh/ListOfGoods.txt", import.meta.url);

// Karakter yang rusak karena file aslinya pernah dibaca dengan encoding yang salah.
const BROKEN = [
  ["ï¼›", "; "], // ；
  ["â€™", "'"], // ’
  ["â€œ", '"'], // “
  ["â€\u009d", '"'], // ”
];
const clean = (s) => BROKEN.reduce((text, [bad, good]) => text.split(bad).join(good), s).replace(/\s+/g, " ").replace(/ ;/g, ";").trim();

// Tiap data satu baris berupa satu nilai CSV yang isinya CSV lagi:
// "\tA,""\t01"",""\t01"",""\t00"",""\tEnglish"",""\tIndonesia"" "
// Beberapa data di file aslinya terpotong ke baris berikutnya, dan baris pertamanya sudah ditutup tanda kutip.
// Baris yang tidak diawali tanda kutip + tab digabung ke baris sebelumnya, tanpa tanda kutip penutup itu.
const lines = [];
for (const line of readFileSync(source, "utf8").split(/\r?\n/).slice(1)) {
  if (line.startsWith('"\t')) lines.push(line);
  else if (line.trim() && lines.length) lines[lines.length - 1] = lines.at(-1).replace(/"\s*$/, "") + ` ${line}`;
}

const rows = [];
for (const line of lines) {
  let inner = line.trim();
  if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
  inner = inner.replace(/""/g, '"');
  // File DJP memakai tanda kutip di tengah nilai secara tidak standar, jadi dibaca dengan mode longgar.
  const [type, section, chapter, group, english, indonesian] = parseDelimited(inner, ",", { lenientQuotes: true })[0].map((f) => f.trim());
  if (type !== "A" || ![section, chapter, group].every((part) => /^\d{2}$/.test(part))) {
    throw new Error(`Data tidak dikenali: ${inner.slice(0, 80)}`);
  }
  rows.push([section + chapter + group, clean(indonesian), clean(english)]);
}

writeFileSync(
  new URL("../src/kode-barang.js", import.meta.url),
  "// Daftar kode barang Coretax dari file referensi DJP, dibuat oleh scripts/kode-barang.mjs. Jangan diedit manual.\n" +
    "// [kode, nama Indonesia, nama Inggris]\n" +
    "export const GOODS_CODES = [\n" +
    rows.map((row) => `  ${JSON.stringify(row)},`).join("\n") +
    "\n];\n",
);
console.log(`${rows.length} kode barang ditulis ke src/kode-barang.js`);
