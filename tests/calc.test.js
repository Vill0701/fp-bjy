import assert from "node:assert/strict";
import { test } from "node:test";
import { allocate, computeFaktur, detectVatMode, inclusiveUnitPrice } from "../src/calc.js";
import { formatSen, mulDiv, ratio } from "../src/money.js";
import { DEFAULT_UNITS } from "../src/satuan.js";
import { buildXml } from "../src/xml.js";

// Data uji buatan, bukan NPWP asli.
const NPWP = "0" + "2".repeat(15);
const data = { items: {}, units: DEFAULT_UNITS };

/** Invoice seperti hasil parseInvoices. lines: [nama, qty, satuan, harga, jumlah, disc]. */
function invoice(lines, summary, extra = {}) {
  const parsed = lines.map(([name, qty, unit, price, total, disc = ""], i) => ({ no: i + 1, name, qty, unit, price, disc, total }));
  const subTotal = parsed.reduce((a, l) => a + l.total, 0);
  const discount = summary?.discount ?? 0;
  const ppn = Math.round(((subTotal - discount) * 11) / 100);
  return {
    number: "J260000001",
    date: "2026-10-09",
    seller: "PT. PENJUAL CONTOH",
    buyerName: "PT. PEMBELI CONTOH",
    buyerNpwp: NPWP,
    pages: [1],
    lines: parsed,
    summary: { subTotal, discount, dpp: Math.round(((subTotal - discount) * 11) / 12), ppn, total: subTotal - discount + ppn, ...summary },
    warnings: [],
    ...extra,
  };
}
const problems = (f) => f.checks.filter((c) => c.level === "error" || c.level === "warn").map((c) => c.message);
const pick = (f, key) => f.lines.map((l) => l[key]);

test("pembulatan dan format angka", () => {
  assert.equal(mulDiv(43000000, 11, 12), 39416667);
  assert.equal(mulDiv(-5, 1, 2), -3);
  assert.equal(ratio([22000000, 1200], [1332]), 19819820); // 220.000 ÷ 1,11 = 198.198,198…
  assert.equal(ratio([5, 1], [2]), 3);
  assert.equal(formatSen(5120120), "51201.2");
  assert.equal(formatSen(12000000), "120000");
  assert.equal(formatSen(13963964), "139639.64");
});

test("harga termasuk PPN dihitung balik dari Harga dan Jumlah di invoice", () => {
  assert.equal(inclusiveUnitPrice(81081, 3, 243243), 90000); // 90.000 ÷ 1,11 = 81.081,08
  assert.equal(inclusiveUnitPrice(366667, 3, 1100000), 407000);
  assert.equal(inclusiveUnitPrice(183784, 1, 183784), 204000);
  // 49.550 bisa berasal dari 55.000 atau 55.001; yang dipilih yang bulat
  assert.equal(inclusiveUnitPrice(49550, 1, 49550), 55000);
  assert.equal(inclusiveUnitPrice(230000, 3, 690000), 255300); // harga bulat: sama persis dengan invoice
  assert.equal(inclusiveUnitPrice(20000, 2.5, 50000), 22200);
  assert.equal(inclusiveUnitPrice(12345, 1, 12345), null); // memang harga sebelum PPN, tidak ada yang bulat
  assert.equal(inclusiveUnitPrice(100000, 3, 200000), null); // Jumlah tidak cocok
});

test("invoice dari harga termasuk PPN dihitung seperti template Excel", () => {
  // Harga termasuk PPN 90.000 × 3 = 270.000; invoice mencetak 81.081 × 3 = 243.243
  const f = computeFaktur(invoice([["SIKU 30 X 30 X 3 X 6M", 3, "BTG", 81081, 243243]]), data);
  assert.deepEqual(problems(f), []);
  assert.ok(f.ready);
  assert.deepEqual(pick(f, "unitInclusive"), [90000]);
  assert.deepEqual(pick(f, "priceSen"), [8108108]);
  assert.deepEqual(pick(f, "taxBaseSen"), [24324324]); // 270.000 ÷ 1,11, bukan 3 × 81.081,08
  assert.deepEqual(pick(f, "otherTaxBaseSen"), [22297297]);
  assert.deepEqual(pick(f, "vatSen"), [2675676]);
  assert.ok(f.checks.some((c) => c.level === "info" && /90\.000 ÷ 1,11 = Rp 81\.081,08/.test(c.message)));
  assert.ok(f.checks.some((c) => c.level === "ok" && /DPP, DPP Nilai Lain, dan PPN faktur sama dengan invoice/.test(c.message)));
  // Sudah sama persis dengan invoice: tidak perlu ada pilihan cara hitung
  assert.equal(f.choice, "template");
  assert.deepEqual(f.options, []);
  assert.deepEqual(f.compared.map((c) => [c.label, c.want, c.diff]), [["DPP", 243243, 0], ["DPP Nilai Lain", 222973, 0], ["PPN", 26757, 0]]);
});

const options = (f) => f.options.map((o) => [o.key, o.matches]);

test("Jumlah baris selisih Rp 1 dari Sub Total karena pembulatan di invoice: tetap siap tanpa edit, dengan pilihan", () => {
  // Excel menyimpan 270.000 ÷ 1,11 = 243.243,24 dan 290.000 ÷ 1,11 = 261.261,26 lalu mencetak 243.243 dan 261.261
  // (jumlahnya 504.504), sedangkan Sub Total dijumlah sebelum dibulatkan: 504.504,50 dicetak 504.505.
  const summary = { subTotal: 504505, dpp: 462462, ppn: 55495, total: 560000 };
  const f = computeFaktur(invoice([["SIKU", 3, "BTG", 81081, 243243], ["HOLLO", 2, "BTG", 130631, 261261]], summary), data);
  assert.deepEqual(problems(f), []);
  assert.ok(f.ready);
  assert.ok(f.checks.some((c) => c.level === "info" && /Jumlah semua baris \(Rp 504\.504\) selisih Rp 1 dari Sub Total \(Rp 504\.505\)/.test(c.message)));
  assert.equal(Math.round(f.totals.taxBaseSen / 100), 504505); // DPP faktur tetap sama dengan Sub Total
  // Dua pilihan ditampilkan; template Excel lebih banyak cocok dengan invoice, jadi itu yang dipakai
  assert.deepEqual(options(f), [["template", 2], ["subtotal", 1]]);
  assert.equal(f.choice, "template");

  // Selisih yang besar (mis. ada baris yang tidak terbaca) tetap ditolak, tanpa pilihan
  const missing = computeFaktur(invoice([["SIKU", 3, "BTG", 81081, 243243]], summary), data);
  assert.equal(missing.ready, false);
  assert.ok(problems(missing).some((m) => /tidak sama dengan Sub Total/.test(m)));
  assert.deepEqual(missing.options, []);
});

test("DPP dipaskan dengan Sub Total kalau itu yang membuat faktur sama dengan invoice; bisa dipilih manual", () => {
  // 55.000 × 4 dan 90.000 × 3 termasuk PPN. Cara template: DPP 441.441,44 dan DPP nilai lain 404.654,65 (invoice 404.654).
  const inv = invoice([["BESI A", 4, "BTG", 49550, 198198], ["BESI B", 3, "BTG", 81081, 243243]]);
  const f = computeFaktur(inv, data);
  assert.deepEqual(options(f), [["template", 2], ["subtotal", 3]]);
  assert.equal(f.choice, "subtotal");
  assert.deepEqual(problems(f), []);
  assert.ok(f.ready);
  // Selisih −0,44 masuk ke baris terbesar (baris 2); DPP nilai lain dan PPN baris itu dihitung ulang
  assert.deepEqual(pick(f, "taxBaseSen"), [19819820, 24324280]);
  assert.deepEqual(pick(f, "otherTaxBaseSen"), [18168168, 22297257]);
  assert.deepEqual(pick(f, "vatSen"), [2180180, 2675671]);
  assert.deepEqual(pick(f, "priceSen"), [4954955, 8108108]); // harga satuan tidak berubah
  assert.equal(f.totals.taxBaseSen, 44144100);
  assert.ok(f.compared.every((c) => c.diff === 0));
  assert.ok(f.checks.some((c) => c.level === "info" && c.message === "DPP dipaskan dengan Sub Total invoice: selisih Rp 0,44 dimasukkan ke baris 2"));

  // Pengguna tetap bisa memilih cara template Excel; selisih Rp 1 hanya jadi info
  const template = computeFaktur({ ...inv, roundingFix: "template" }, data);
  assert.equal(template.choice, "template");
  assert.deepEqual(pick(template, "taxBaseSen"), [19819820, 24324324]);
  assert.deepEqual(problems(template), []);
  assert.ok(template.checks.some((c) => c.level === "info" && /DPP Nilai Lain faktur .* beda Rp 1/.test(c.message)));
});

test("harga bulat sebelum PPN: angka faktur sama persis dengan invoice", () => {
  const f = computeFaktur(invoice([["CNP 150", 32, "BTG", 526000, 16832000], ["PLAT 12", 1, "LBR", 3630000, 3630000], ["PLAT 8", 20, "PIECE", 20000, 400000]]), data);
  assert.deepEqual(problems(f), []);
  assert.deepEqual(pick(f, "priceSen"), [52600000, 363000000, 2000000]);
  assert.deepEqual(pick(f, "taxBaseSen"), [1683200000, 363000000, 40000000]);
  assert.deepEqual(pick(f, "otherTaxBaseSen"), [1542933333, 332750000, 36666667]);
  assert.deepEqual(pick(f, "vatSen"), [185152000, 39930000, 4400000]);
  assert.deepEqual(pick(f, "code"), ["720000", "720000", "720000"]);
  assert.deepEqual(pick(f, "unit"), ["UM.0021", "UM.0020", "UM.0021"]);
  assert.deepEqual(f.buyer, { npwp: NPWP, nitku: NPWP + "000000" });
  assert.equal(f.trxCode, "04");
});

test("harga ganjil sebelum PPN dipakai apa adanya", () => {
  const f = computeFaktur(invoice([["BARANG GANJIL", 1, "BTG", 12345, 12345]]), data);
  assert.deepEqual(problems(f), []);
  assert.deepEqual([f.lines[0].unitInclusive, f.lines[0].priceSen, f.lines[0].taxBaseSen], [null, 1234500, 1234500]);
});

test("invoice berdiskon: diskon jadi potongan harga, dengan peringatan untuk dicek", () => {
  // Diskon 10% per baris dan diskon invoice 18.000 dibagi menurut Jumlah
  const inv = invoice([["A", 2, "BTG", 100000, 180000, "10%"], ["B", 1, "BTG", 180000, 180000]], { discount: 18000 });
  const f = computeFaktur(inv, data);
  assert.deepEqual(pick(f, "priceSen"), [10000000, 18000000]);
  assert.deepEqual(pick(f, "discountSen"), [2900000, 900000]);
  assert.deepEqual(pick(f, "taxBaseSen"), [17100000, 17100000]);
  assert.deepEqual(problems(f), ["Invoice ini berdiskon. Belum ada contoh invoice berdiskon, jadi cek lagi angka potongan harganya."]);
  assert.ok(f.ready);
});

test("invoice yang harganya sudah termasuk PPN", () => {
  // Total = Sub Total; PPN 11/111 × 270.000 = 26.757
  const inv = invoice([["A", 3, "BTG", 90000, 270000]], { ppn: 26757, total: 270000, dpp: undefined });
  delete inv.summary.dpp;
  assert.equal(detectVatMode(inv.summary, 1), "inclusive");
  const f = computeFaktur(inv, data);
  assert.deepEqual(problems(f), []);
  assert.deepEqual([f.lines[0].priceSen, f.lines[0].taxBaseSen, f.lines[0].vatSen], [8108108, 24324324, 2675676]);
});

test("Qty × Harga yang jauh dari Jumlah diperingatkan", () => {
  const f = computeFaktur(invoice([["A", 3, "BTG", 100000, 290000]]), data);
  assert.ok(problems(f).some((m) => /Baris 1: Qty × Harga/.test(m)));
});

test("NPWP pembeli: dari invoice, 15 digit, kosong, atau diisi manual", () => {
  const fifteen = computeFaktur(invoice([["A", 1, "BTG", 100000, 100000]], {}, { buyerNpwp: NPWP.slice(1) }), data);
  assert.equal(fifteen.buyer.npwp, NPWP);

  const none = computeFaktur(invoice([["A", 1, "BTG", 100000, 100000]], {}, { buyerNpwp: "" }), data);
  assert.equal(none.buyer, null);
  assert.ok(problems(none).includes("NPWP pembeli tidak ada di invoice. Isi manual."));
  assert.equal(none.ready, false);

  const zeros = computeFaktur(invoice([["A", 1, "BTG", 100000, 100000]], {}, { buyerNpwp: "0".repeat(16) }), data);
  assert.equal(zeros.ready, false);

  const other = "0" + "3".repeat(15);
  const manual = computeFaktur(
    invoice([["A", 1, "BTG", 100000, 100000]], {}, { buyerNpwp: "", override: { npwp: other, nitku: other + "000001", trxCode: "03" } }),
    data,
  );
  assert.deepEqual(manual.buyer, { npwp: other, nitku: other + "000001" });
  assert.equal(manual.trxCode, "03");
  assert.ok(manual.ready);
});

test("invoice dari penjual lain ditolak; beda spasi atau huruf besar tidak masalah", () => {
  const inv = invoice([["A", 1, "BTG", 100000, 100000]]);
  assert.ok(computeFaktur(inv, data, { sellerName: "pt.  penjual contoh" }).ready);
  const other = computeFaktur(inv, data, { sellerName: "PT. PENJUAL LAIN" });
  assert.equal(other.ready, false);
  assert.match(problems(other)[0], /dari PT\. PENJUAL CONTOH, bukan PT\. PENJUAL LAIN/);
});

test("kode barang bawaan, kode yang diubah, dan satuan yang belum dikenal", () => {
  const items = { "PIPA KHUSUS": { coretaxCode: "730000", unit: "" }, "BAUT SET": { coretaxCode: "", unit: "UM.0019" } };
  const inv = invoice([["PIPA  khusus", 1, "BTG", 100000, 100000], ["BAUT SET", 1, "BTG", 100000, 100000], ["CAT", 1, "KALENG", 100000, 100000]]);
  const f = computeFaktur(inv, { items, units: DEFAULT_UNITS }, { goodsCode: "720000" });
  assert.deepEqual(pick(f, "code"), ["730000", "720000", "720000"]);
  assert.deepEqual(pick(f, "unit"), ["UM.0021", "UM.0019", ""]);
  assert.deepEqual(problems(f), ["Satuan Coretax belum diisi untuk 1 baris"]);
});

test("ringkasan tidak cocok dengan rumus PPN ditandai", () => {
  const f = computeFaktur(invoice([["A", 1, "BTG", 100000, 100000]], { ppn: 5000 }), data);
  assert.equal(f.ready, false);
  assert.ok(problems(f).some((m) => /PPN di invoice tidak cocok/.test(m)));
});

test("diskon total dibagi proporsional dan jumlahnya pas", () => {
  assert.deepEqual(allocate(1000000, [10000000, 5000000, 5000000]), [500000, 250000, 250000]);
  const parts = allocate(100000, [3333300, 3333300, 3333400]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100000);
});

test("XML: nama dan alamat pembeli pengganti, email '-', BOM dan CRLF", () => {
  const f = computeFaktur(invoice([["SIKU <A&B>", 3, "BTG", 81081, 243243]]), data);
  const xml = buildXml({ tin: NPWP, idtku: NPWP + "000000" }, [f]);
  assert.ok(xml.startsWith("﻿<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n<TaxInvoiceBulk "));
  assert.ok(!xml.endsWith("\n"));
  for (const part of [
    "<BuyerName>KONGSO PPN</BuyerName>",
    "<BuyerAdress>BEKASI</BuyerAdress>",
    "<BuyerEmail>-</BuyerEmail>",
    `<BuyerIDTKU>${NPWP}000000</BuyerIDTKU>`,
    "<Code>720000</Code>",
    "<Name>SIKU &lt;A&amp;B&gt;</Name>",
    "<Price>81081.08</Price>",
    "<TaxBase>243243.24</TaxBase>",
    "<OtherTaxBase>222972.97</OtherTaxBase>",
    "<VAT>26756.76</VAT>",
  ]) {
    assert.ok(xml.includes(part), part);
  }
  assert.throws(() => buildXml({ tin: NPWP, idtku: NPWP + "000000" }, [{ ...f, ready: false }]), /belum lengkap/);
});
