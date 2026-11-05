import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDate, parseInvoices, parseNumber } from "../src/parser.js";

// Data uji buatan, bukan NPWP asli.
const NPWP = "0" + "1".repeat(15);

/**
 * Halaman tiruan dengan tata letak seperti invoice asli (posisi dalam pt). `scale` dan `dx` meniru
 * halaman yang diperkecil Excel saat export ke PDF.
 */
function page(number, { scale = 1, dx = 0, rows, summary, extra = [], ...head }) {
  const items = [];
  const put = (x, y, str, w = str.length * 3.6) => items.push({ str, x: dx + x * scale, y: y * scale, w: w * scale });
  const right = (edge, y, str) => put(edge - str.length * 3.6, y, str);
  const middle = (mid, y, str) => put(mid - (str.length * 3.6) / 2, y, str);
  const labelled = (x, y, label, value) => {
    put(x, y, label);
    put(x + 57, y, ":", 2.5);
    put(x + 66, y, value);
  };
  put(382, 23.4, "FAKTUR PENJUALAN", 148);
  put(68, 25.3, head.seller ?? "PT. PENJUAL CONTOH");
  put(68, 34.9, "JL. RAYA CONTOH NO. 1");
  labelled(64, 73.7, "Penjualan", head.number);
  labelled(371, 73.7, "Tanggal", head.date ?? "09 Oktober 2026");
  labelled(64, 83.9, "Customer", head.customer ?? "C0001-PT. PEMBELI CONTOH");
  labelled(64, 93.7, "Alamat", "JL. PEMBELI NO. 2");
  put(130, 103.5, "BEKASI");
  if (head.npwp !== null) put(130, 113.3, `NPWP : ${head.npwp ?? NPWP}`);
  put(64, 142.7, "=".repeat(103), 535.6);
  put(272.1, 152.1, "QTY", 13.5);
  put(327.9, 152.1, "HARGA", 22.8);
  put(382.6, 152.1, "DISC", 15.9);
  put(466.7, 152.1, "JUMLAH", 26);
  put(64, 161.5, "=".repeat(103), 535.6);
  rows.forEach(([name, qty, unit, price, disc, total], i) => {
    const y = 171.3 + i * 9.8;
    for (const [x, part] of Array.isArray(name) ? name : [[64, name]]) put(x, y + 0.2, part);
    middle(260, y, qty);
    middle(292.5, y, unit);
    right(363, y, price);
    if (disc) middle(390, y, disc);
    right(528.3, y, total);
  });
  for (const [x, y, str] of extra) put(x, y, str);
  put(64, 269.4, "=".repeat(103), 535.6);
  put(64, 279.2, "PEMBAYARAN DAPAT DITRANSFER MELALUI :");
  summary.forEach(([label, value], i) => {
    const y = 279.2 + i * 9.8;
    right(409, y, label);
    put(419, y, ":", 1.6);
    right(528.8, y, value);
  });
  put(454, 347.8, "HORMAT KAMI,");
  return { number, items };
}

const SUMMARY = [["SUB TOTAL", "1.283.784"], ["DISCOUNT", "-"], ["DPP", "1.176.802"], ["PPN", "141.216"], ["TOTAL", "1.425.000"]];
const ROWS = [
  ["PIPA HITAM 1/2\" X 6M", "3", "BTG", "366.667", "", "1.100.000"],
  ["PLAT 3MM X 1200 X 2400", "1", "LBR", "183.784", "", "183.784"],
];

test("angka dan tanggal format Indonesia", () => {
  assert.equal(parseNumber("16.297.000"), 16297000);
  assert.equal(parseNumber("910.000"), 910000);
  assert.equal(parseNumber("49"), 49);
  assert.equal(parseNumber("2,5"), 2.5);
  assert.equal(parseNumber("1.234,75"), 1234.75);
  assert.equal(parseNumber("-"), null);
  assert.equal(parseNumber("1.5"), null);
  assert.equal(parseNumber("BTG"), null);
  assert.equal(parseDate("09 Oktober 2026"), "2026-10-09");
  assert.equal(parseDate("1 Agustus 2026"), "2026-08-01");
  assert.equal(parseDate("5 Mei 2026"), "2026-05-05");
  assert.equal(parseDate("31 Desember 2026"), "2026-12-31");
  assert.equal(parseDate("27 Juni 2026"), "2026-06-27");
  assert.equal(parseDate("Oktober 2026"), null);
});

test("membaca kop, pembeli, NPWP, baris barang, dan ringkasan", () => {
  const { invoices, warnings } = parseInvoices([page(1, { number: "J260000001", rows: ROWS, summary: SUMMARY })]);
  assert.deepEqual(warnings, []);
  assert.equal(invoices.length, 1);
  const inv = invoices[0];
  assert.deepEqual(inv.warnings, []);
  assert.equal(inv.number, "J260000001");
  assert.equal(inv.date, "2026-10-09");
  assert.equal(inv.seller, "PT. PENJUAL CONTOH");
  assert.equal(inv.buyerCode, "C0001");
  assert.equal(inv.buyerName, "PT. PEMBELI CONTOH");
  assert.equal(inv.buyerNpwp, NPWP);
  assert.deepEqual(inv.summary, { subTotal: 1283784, discount: 0, dpp: 1176802, ppn: 141216, total: 1425000 });
  assert.deepEqual(inv.lines, [
    { no: 1, name: "PIPA HITAM 1/2\" X 6M", qty: 3, unit: "BTG", price: 366667, disc: "", total: 1100000 },
    { no: 2, name: "PLAT 3MM X 1200 X 2400", qty: 1, unit: "LBR", price: 183784, disc: "", total: 183784 },
  ]);
});

/** Isi invoice tanpa posisi tanda (posisi memang ikut berubah kalau halamannya diperkecil). */
const content = ({ marks, ...inv }) => inv;

test("kolom tetap terbaca walau halaman diperkecil dan bergeser", () => {
  const normal = parseInvoices([page(1, { number: "J260000001", rows: ROWS, summary: SUMMARY })]).invoices[0];
  for (const [scale, dx] of [[0.85, 40], [0.7, 90], [1.2, -10]]) {
    const scaled = parseInvoices([page(1, { number: "J260000001", rows: ROWS, summary: SUMMARY, scale, dx })]).invoices[0];
    assert.deepEqual(content(scaled), content(normal), `skala ${scale}`);
  }
});

test("posisi teks yang dibaca dicatat untuk ditandai saat PDF ditampilkan", () => {
  const [one, two] = parseInvoices([
    page(1, { number: "J260000001", rows: ROWS, summary: SUMMARY }),
    page(2, { number: "J260000002", rows: ROWS.slice(0, 1), summary: SUMMARY }),
  ]).invoices;
  assert.deepEqual(Object.keys(one.marks.header), ["number", "date", "customer", "npwp"]);
  assert.deepEqual(Object.keys(one.marks.summary), ["subTotal", "discount", "dpp", "ppn", "total"]);
  assert.equal(one.marks.lines.length, one.lines.length);
  one.marks.lines.forEach((m, i) => {
    const baseline = 171.3 + i * 9.8;
    assert.equal(m.page, 1);
    assert.ok(m.top < baseline && baseline < m.bottom && m.bottom - m.top < 12, `baris ${i + 1}: tinggi kotak`);
    assert.ok(m.x0 <= 64 && m.x1 >= 528, `baris ${i + 1}: dari nama barang sampai Jumlah`);
  });
  assert.ok(one.marks.lines[0].bottom < one.marks.lines[1].top, "kotak baris tidak bertumpuk");
  // Nilai ringkasan: dari label sampai angkanya
  assert.ok(one.marks.summary.ppn.x0 < 409 && one.marks.summary.ppn.x1 >= 528);
  // Invoice di halaman 2: semua tanda di halaman 2
  const all = (inv) => [...Object.values(inv.marks.header), ...inv.marks.lines, ...Object.values(inv.marks.summary)];
  assert.ok(all(two).every((m) => m.page === 2));
});

test("satu PDF berisi beberapa invoice, satu per halaman", () => {
  const { invoices } = parseInvoices([
    page(1, { number: "J260000001", rows: ROWS, summary: SUMMARY }),
    page(2, { number: "J260000002", rows: ROWS.slice(0, 1), summary: SUMMARY, date: "08 Oktober 2026" }),
  ]);
  assert.deepEqual(invoices.map((i) => [i.number, i.date, i.lines.length, i.pages]), [
    ["J260000001", "2026-10-09", 2, [1]],
    ["J260000002", "2026-10-08", 1, [2]],
  ]);
});

test("nama barang yang terpotong jadi beberapa teks, satuan lain, dan Qty desimal", () => {
  const rows = [
    [[[64, "STRIP"], [88, "40 X 3 X 6M"]], "19", "BTG", "130.000", "", "2.470.000"],
    ["PLAT 8MM X 100 X 120", "20", "PIECE", "20.000", "", "400.000"],
    ["BESI KG", "2,5", "KG", "20.000", "", "50.000"],
  ];
  const inv = parseInvoices([page(1, { number: "J260000003", rows, summary: SUMMARY })]).invoices[0];
  assert.deepEqual(inv.lines.map((l) => [l.name, l.qty, l.unit]), [
    ["STRIP 40 X 3 X 6M", 19, "BTG"],
    ["PLAT 8MM X 100 X 120", 20, "PIECE"],
    ["BESI KG", 2.5, "KG"],
  ]);
});

test("nama yang turun ke baris lain disambung ke baris barang terdekat, dengan peringatan", () => {
  // Baris pertama nama ada di atas angka (Excel menaruh angka sejajar baris terbawah nama).
  const rows = [["PANJANG SEKALI", "1", "BTG", "100.000", "", "100.000"]];
  const inv = parseInvoices([page(1, { number: "J260000004", rows, summary: SUMMARY, extra: [[64, 165.0, "PIPA BESI UKURAN"]] })]).invoices[0];
  assert.equal(inv.lines.length, 1);
  assert.equal(inv.lines[0].name, "PIPA BESI UKURAN PANJANG SEKALI");
  assert.match(inv.warnings.join("\n"), /lebih dari satu baris/);
  // Tanda di PDF menutupi kedua baris teks nama itu
  assert.ok(inv.marks.lines[0].top < 165 && inv.marks.lines[0].bottom > 171.3);
});

test("kolom Disc dan invoice tanpa NPWP", () => {
  const rows = [["BARANG DISKON", "2", "BTG", "100.000", "10%", "180.000"]];
  const inv = parseInvoices([page(1, { number: "J260000005", rows, summary: SUMMARY, npwp: null })]).invoices[0];
  assert.equal(inv.lines[0].disc, "10%");
  assert.equal(inv.buyerNpwp, "");
});

test("halaman tanpa nomor invoice dilewati dengan peringatan", () => {
  const { invoices, warnings } = parseInvoices([{ number: 1, items: [{ str: "Halaman lain", x: 10, y: 10, w: 40 }] }]);
  assert.deepEqual(invoices, []);
  assert.deepEqual(warnings, ["Halaman 1 dilewati: nomor invoice tidak ditemukan"]);
});
