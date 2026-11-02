// CSV sederhana (RFC 4180): nilai yang berisi pemisah, kutip, atau baris baru diberi tanda kutip.
// Dipakai untuk file data master di repo private (supaya tampil sebagai tabel di GitHub) dan untuk impor.

/**
 * Pecah teks menjadi baris-baris berisi sel, dengan pemisah tertentu (koma, titik koma, atau tab).
 * Tanda kutip hanya membuka nilai berkutip di awal sel, kecuali `lenientQuotes` (untuk file yang tidak standar).
 */
export function parseDelimited(text, delimiter = ",", { lenientQuotes = false } = {}) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[i++];
      else quoted = false;
    } else if (c === '"' && (cell === "" || lenientQuotes)) quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      rows.push([...row, cell]);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) rows.push([...row, cell]);
  return rows;
}

export function parseCsv(text) {
  const [header = [], ...body] = parseDelimited(text).filter((r) => r.some((c) => c.trim() !== ""));
  const keys = header.map((k) => k.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

/** Teks tempelan dari Excel atau isi file CSV/TXT: pemisah dipilih otomatis (tab, titik koma, lalu koma). */
export function rowsFromText(text) {
  const clean = text.replace(/^﻿/, "");
  const sample = clean.split(/\r?\n/, 20).join("\n");
  const delimiter = ["\t", ";", ","].find((d) => sample.includes(d)) ?? "\t";
  return parseDelimited(clean, delimiter);
}

export function toCsv(columns, records) {
  const escape = (value) => {
    const s = String(value ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...records.map((r) => columns.map((c) => escape(r[c])).join(","))].join("\n") + "\n";
}
