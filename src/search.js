// Pencarian kode barang Coretax berdasarkan kata (nama Indonesia/Inggris) atau angka kode.

/** Huruf kecil tanpa tanda aksen, untuk pencocokan. */
export const fold = (text) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export const words = (query) => fold(query).split(/[^a-z0-9]+/).filter(Boolean);

function wordScore(text, term, whole, prefix) {
  if (new RegExp(`\\b${term}\\b`).test(text)) return whole;
  if (new RegExp(`\\b${term}`).test(text)) return prefix;
  return 0;
}

/**
 * Cari di daftar [kode, nama Indonesia, nama Inggris]; semua kata harus ada.
 * Urutan: kode yang diawali angka yang diketik, kata utuh di nama Indonesia, awal kata, lalu nama Inggris.
 * Nilai yang sama diurutkan menurut posisi kata pertama di nama Indonesia (makin awal makin atas).
 */
export function searchCodes(list, query, limit = 40) {
  const terms = words(query);
  if (!terms.length) return [];
  const found = [];
  for (const entry of list) {
    const [code, indonesian, english] = entry;
    const id = fold(indonesian);
    const en = fold(english);
    if (!terms.every((t) => code.includes(t) || id.includes(t) || en.includes(t))) continue;
    let score = 0;
    for (const t of terms) {
      if (code.startsWith(t)) score += 5;
      score += Math.max(wordScore(id, t, 3, 2), wordScore(en, t, 2, 1));
    }
    const at = id.indexOf(terms[0]);
    found.push({ entry, score, at: at < 0 ? Infinity : at });
  }
  return found
    .sort((a, b) => b.score - a.score || a.at - b.at || a.entry[0].localeCompare(b.entry[0]))
    .slice(0, limit)
    .map((f) => f.entry);
}

/** Tebakan kata pencarian dari nama barang: kata pertama yang terdiri dari minimal 3 huruf. */
export const guessQuery = (name) => (name.match(/[A-Za-z]{3,}/) ?? [""])[0].toLowerCase();
