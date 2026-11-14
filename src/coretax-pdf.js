// Membaca PDF faktur pajak yang sudah terbit di Coretax (teks hasil extractPages), lalu mencocokkannya dengan
// faktur yang dibuat aplikasi lewat "(Referensi: …)". Dipakai untuk memastikan yang terbit sama dengan invoice.
import { UNIT_NAMES } from "./satuan.js";

const unitCodes = Object.fromEntries(Object.entries(UNIT_NAMES).map(([code, name]) => [name, code]));

/** "81.081,08" → 8108108 sen */
const senOf = (text) => Math.round(Number(text.replace(/\./g, "").replace(",", ".")) * 100);

/** Baris teks per halaman: potongan teks yang sejajar digabung dengan spasi. */
export function textLines(pages) {
  const out = [];
  for (const page of pages) {
    const lines = [];
    for (const it of [...page.items].sort((a, b) => a.y - b.y || a.x - b.x)) {
      const last = lines.at(-1);
      if (last && it.y - last.y <= 1.5) last.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    out.push(...lines.map((l) => l.items.sort((a, b) => a.x - b.x).map((it) => it.str).join(" ")));
  }
  return out;
}

const GOODS_PRICE = /^Rp ([\d.,]+) x ([\d.,]+) (.+)$/;
const GOODS_ROW = /^(\d+) (\d{6}) ([\d.,]+)$/;
const GOODS_DISCOUNT = /^Potongan Harga = Rp ([\d.,]+)$/;

/** Satu barang: baris-baris dari nama sampai "PPnBM (…)". */
function readGoods(block) {
  const price = block.map((l) => GOODS_PRICE.exec(l)).find(Boolean);
  const row = block.map((l) => GOODS_ROW.exec(l)).find(Boolean);
  if (!price || !row) return null;
  const discount = block.map((l) => GOODS_DISCOUNT.exec(l)).find(Boolean);
  const name = block.slice(0, block.indexOf(price[0])).filter((l) => l !== row[0]).join(" ");
  return {
    no: Number(row[1]),
    name,
    priceSen: senOf(price[1]),
    qty: senOf(price[2]) / 100,
    unit: unitCodes[price[3]] ?? price[3],
    code: row[2],
    grossSen: senOf(row[3]), // Harga × Qty, sebelum potongan
    discountSen: discount ? senOf(discount[1]) : 0,
  };
}

/** Isi satu faktur pajak Coretax dari baris-baris teksnya. */
function readFaktur(lines, ref) {
  const goods = [];
  let start = lines.findIndex((l) => /\(Rp\)$/.test(l)) + 1; // setelah judul kolom tabel
  lines.forEach((line, i) => {
    if (!/^PPnBM \(/.test(line)) return;
    const item = readGoods(lines.slice(start, i + 1));
    if (item) goods.push(item);
    start = i + 1;
  });
  const total = (label) => {
    const line = lines.find((l) => l.startsWith(label) && /[\d.,]+$/.test(l.slice(label.length).trim()));
    return line ? senOf(line.slice(label.length).trim()) : null;
  };
  const buyerAt = lines.findIndex((l) => /^Pembeli Barang Kena Pajak/.test(l));
  const buyer = buyerAt < 0 ? [] : lines.slice(buyerAt + 1, start);
  const value = (re) => buyer.map((l) => re.exec(l)).find(Boolean)?.[1] ?? "";
  return {
    ref,
    number: lines.map((l) => /^Kode dan Nomor Seri Faktur Pajak:\s*(\d+)/.exec(l)).find(Boolean)?.[1] ?? "",
    buyerName: value(/^Nama\s*:\s*(.+)$/),
    buyerNpwp: value(/^NPWP\s*:\s*(\d{15,16})\b/),
    buyerNitku: value(/#(\d{22})\b/),
    goods,
    grossSen: total("Harga Jual / Penggantian / Uang Muka / Termin"),
    discountSen: total("Dikurangi Potongan Harga"),
    otherTaxBaseSen: total("Dasar Pengenaan Pajak"),
    vatSen: total("Jumlah PPN (Pajak Pertambahan Nilai)"),
  };
}

/** Faktur pajak Coretax di sebuah PDF (bisa beberapa); tiap faktur diakhiri baris "(Referensi: …)". Kosong kalau bukan PDF faktur. */
export function readCoretaxFakturs(pages) {
  const lines = textLines(pages);
  if (!lines.some((l) => l.startsWith("Kode dan Nomor Seri Faktur Pajak"))) return [];
  const fakturs = [];
  let start = 0;
  lines.forEach((line, i) => {
    const ref = /\(Referensi: (.+)\)/.exec(line)?.[1];
    if (!ref) return;
    fakturs.push(readFaktur(lines.slice(start, i + 1), ref.trim()));
    start = i + 1;
  });
  return fakturs;
}

const nameKey = (s) => String(s ?? "").toUpperCase().replace(/\s+/g, " ").trim();
const rupiah = (sen) => Math.round(sen / 100) * 100; // total di faktur Coretax dibulatkan ke rupiah

/**
 * Cocokkan faktur Coretax `c` dengan faktur buatan aplikasi.
 * ours = { npwp?, nitku?, totals: { discountSen, taxBaseSen, otherTaxBaseSen, vatSen }, lines? }
 * `lines` (baris faktur hasil computeFaktur) hanya ada kalau invoicenya masih di daftar; dari Riwayat hanya total.
 * Hasil: daftar { label, ok, ours, theirs, kind } dengan kind: "money" (sen), "text", atau "npwp".
 */
export function compareCoretax(c, ours) {
  const rows = [];
  const add = (label, mine, theirs, kind = "money") => {
    if (mine == null || theirs == null) return;
    rows.push({ label, ok: mine === theirs, ours: mine, theirs, kind });
  };
  if (ours.npwp) add("NPWP pembeli", ours.npwp, c.buyerNpwp.padStart(16, "0"), "npwp");
  if (ours.nitku && c.buyerNitku) add("NITKU pembeli", ours.nitku, c.buyerNitku, "npwp");
  const t = ours.totals;
  if (t.taxBaseSen != null) {
    const discount = t.discountSen ?? 0;
    add("Harga Jual", rupiah(t.taxBaseSen + discount), c.grossSen);
    add("Potongan Harga", rupiah(discount), c.discountSen);
    add("DPP Nilai Lain", rupiah(t.otherTaxBaseSen), c.otherTaxBaseSen);
    add("PPN", rupiah(t.vatSen), c.vatSen);
  }
  if (ours.lines) {
    add("Jumlah baris barang", ours.lines.length, c.goods.length, "text");
    ours.lines.forEach((l, i) => {
      const g = c.goods[i];
      if (!g) return;
      const at = `Baris ${i + 1}`;
      add(`${at}: nama barang`, nameKey(l.name), nameKey(g.name), "text");
      add(`${at}: kode barang`, l.code, g.code, "text");
      add(`${at}: satuan`, l.unit, g.unit, "text");
      add(`${at}: Qty`, Math.round(l.qty * 100) / 100, g.qty, "text");
      add(`${at}: harga satuan`, l.priceSen, g.priceSen);
      add(`${at}: harga × qty`, l.taxBaseSen + l.discountSen, g.grossSen);
      add(`${at}: potongan harga`, l.discountSen, g.discountSen);
    });
  }
  return rows;
}
