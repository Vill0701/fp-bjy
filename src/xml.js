// Menyusun XML "TaxInvoiceBulk" untuk impor faktur pajak keluaran di Coretax.
// Formatnya disamakan dengan file buatan pengguna: BOM UTF-8, baris CRLF, indentasi 2 spasi.
import { DEFAULT_SETTINGS } from "./calc.js";
import { formatQty, formatSen } from "./money.js";

/** Karakter kontrol tidak boleh ada di XML; kadang ikut terbaca dari teks PDF. */
export const cleanText = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
const escapeXml = (s) => cleanText(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * seller = { tin: NPWP penjual 16 digit, idtku: NITKU penjual 22 digit }
 * fakturs = hasil computeFaktur(); semuanya harus sudah `ready`.
 */
export function buildXml(seller, fakturs, settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const notReady = fakturs.filter((f) => !f.ready).map((f) => f.number);
  if (notReady.length) throw new Error(`Faktur belum lengkap: ${notReady.join(", ")}`);

  const out = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TaxInvoiceBulk xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
  ];
  const el = (depth, name, value) =>
    out.push(" ".repeat(depth) + (value === "" ? `<${name}/>` : `<${name}>${escapeXml(value)}</${name}>`));

  el(2, "TIN", seller.tin);
  out.push("  <ListOfTaxInvoice>");
  for (const f of fakturs) {
    out.push("    <TaxInvoice>");
    el(6, "TaxInvoiceDate", f.date);
    el(6, "TaxInvoiceOpt", "Normal");
    el(6, "TrxCode", f.trxCode);
    el(6, "AddInfo", "");
    el(6, "CustomDoc", "");
    el(6, "CustomDocMonthYear", "");
    el(6, "RefDesc", f.number);
    el(6, "FacilityStamp", "");
    el(6, "SellerIDTKU", seller.idtku);
    el(6, "BuyerTin", f.buyer.npwp);
    el(6, "BuyerDocument", "TIN");
    el(6, "BuyerCountry", "IDN");
    el(6, "BuyerDocumentNumber", "-");
    el(6, "BuyerName", s.buyerName);
    el(6, "BuyerAdress", s.buyerAddress); // ejaan "Adress" memang begitu di format Coretax
    el(6, "BuyerEmail", s.buyerEmail);
    el(6, "BuyerIDTKU", f.buyer.nitku);
    out.push("      <ListOfGoodService>");
    for (const l of f.lines) {
      out.push("        <GoodService>");
      el(10, "Opt", l.opt);
      el(10, "Code", l.code);
      el(10, "Name", l.name);
      el(10, "Unit", l.unit);
      el(10, "Price", formatSen(l.priceSen));
      el(10, "Qty", formatQty(l.qty));
      el(10, "TotalDiscount", formatSen(l.discountSen));
      el(10, "TaxBase", formatSen(l.taxBaseSen));
      el(10, "OtherTaxBase", formatSen(l.otherTaxBaseSen));
      el(10, "VATRate", String(s.vatRate));
      el(10, "VAT", formatSen(l.vatSen));
      el(10, "STLGRate", "0");
      el(10, "STLG", "0");
      out.push("        </GoodService>");
    }
    out.push("      </ListOfGoodService>");
    out.push("    </TaxInvoice>");
  }
  out.push("  </ListOfTaxInvoice>");
  out.push("</TaxInvoiceBulk>");
  return "﻿" + out.join("\r\n");
}

/** Isi sebuah tag: "" untuk tag kosong (<AddInfo/>), null kalau tidak ada. */
function tagText(xml, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  if (m) return unescapeXml(m[1]);
  return new RegExp(`<${name}/>`).test(xml) ? "" : null;
}

const blocksOf = (xml, name) => xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "g")) ?? [];

const senOf = (text) => (text == null || text.trim() === "" || !Number.isFinite(Number(text)) ? null : Math.round(Number(text) * 100));

/** Baca kembali XML buatan buildXml. Angka dalam sen; total faktur = jumlah semua baris. */
export function readXml(xml) {
  return {
    tin: tagText(xml, "TIN"),
    fakturs: blocksOf(xml, "TaxInvoice").map((block) => {
      const lines = blocksOf(block, "GoodService").map((gs) => ({
        code: tagText(gs, "Code"),
        name: tagText(gs, "Name"),
        unit: tagText(gs, "Unit"),
        priceSen: senOf(tagText(gs, "Price")),
        qty: Number(tagText(gs, "Qty") ?? NaN),
        discountSen: senOf(tagText(gs, "TotalDiscount")),
        taxBaseSen: senOf(tagText(gs, "TaxBase")),
        otherTaxBaseSen: senOf(tagText(gs, "OtherTaxBase")),
        vatRate: Number(tagText(gs, "VATRate") ?? NaN),
        vatSen: senOf(tagText(gs, "VAT")),
      }));
      const sum = (key) => lines.reduce((a, l) => a + (l[key] ?? 0), 0);
      return {
        number: tagText(block, "RefDesc"),
        date: tagText(block, "TaxInvoiceDate"),
        trxCode: tagText(block, "TrxCode"),
        sellerIdtku: tagText(block, "SellerIDTKU"),
        buyerTin: tagText(block, "BuyerTin"),
        buyerIdtku: tagText(block, "BuyerIDTKU"),
        lines,
        totals: { discountSen: sum("discountSen"), taxBaseSen: sum("taxBaseSen"), otherTaxBaseSen: sum("otherTaxBaseSen"), vatSen: sum("vatSen") },
      };
    }),
  };
}

const LINE_AMOUNTS = [["priceSen", "Harga"], ["discountSen", "Potongan Harga"], ["taxBaseSen", "DPP"], ["otherTaxBaseSen", "DPP Nilai Lain"], ["vatSen", "PPN"]];

/**
 * Periksa file XML sebelum di-download: isinya dibaca ulang lalu dicocokkan dengan faktur yang tampil di layar
 * (jadi rekap = isi file), dan dengan format serta rumus yang dipakai Coretax. Hasilnya daftar masalah; kosong = aman.
 */
export function verifyXml(xml, seller, fakturs, settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const problems = [];
  const read = readXml(xml);
  const isDigits = (value, n) => typeof value === "string" && new RegExp(`^\\d{${n}}$`).test(value);

  if (read.tin !== seller.tin || !isDigits(read.tin, 16)) problems.push("NPWP penjual di XML tidak sama dengan Pengaturan, atau bukan 16 angka");
  if (read.fakturs.length !== fakturs.length) {
    problems.push(`XML berisi ${read.fakturs.length} faktur, seharusnya ${fakturs.length}`);
    return problems;
  }
  const refs = read.fakturs.map((x) => x.number);
  for (const ref of new Set(refs.filter((r, i) => refs.indexOf(r) !== i))) problems.push(`${ref}: nomor referensi muncul lebih dari sekali`);

  read.fakturs.forEach((x, i) => {
    const f = fakturs[i];
    const add = (message) => problems.push(`${f.number}: ${message}`);
    const same = (label, value, want) => value !== want && add(`${label} di XML tidak sama dengan di layar`);
    same("nomor referensi", x.number, f.number);
    same("tanggal", x.date, f.date);
    same("kode transaksi", x.trxCode, f.trxCode);
    same("NITKU penjual", x.sellerIdtku, seller.idtku);
    same("NPWP pembeli", x.buyerTin, f.buyer?.npwp);
    same("NITKU pembeli", x.buyerIdtku, f.buyer?.nitku);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date ?? "")) add("tanggal faktur tidak berformat tahun-bulan-tanggal");
    if (!/^\d{2}$/.test(x.trxCode ?? "")) add("kode transaksi harus 2 angka");
    if (!isDigits(x.sellerIdtku, 22)) add("NITKU penjual harus 22 angka");
    if (!isDigits(x.buyerTin, 16)) add("NPWP pembeli harus 16 angka");
    if (!isDigits(x.buyerIdtku, 22)) add("NITKU pembeli harus 22 angka");
    if (!x.lines.length) add("tidak ada baris barang");
    if (x.lines.length !== f.lines.length) return add(`XML berisi ${x.lines.length} baris barang, seharusnya ${f.lines.length}`);

    // Selisih wajar Harga × Qty − Potongan terhadap DPP: harga dibulatkan ke sen (½ sen per unit), DPP dibulatkan
    // ke sen, dan pilihan "DPP pas dengan Sub Total" (setengah rupiah per baris)
    const slack = 1 + 100 * Math.max(1, Math.ceil(x.lines.length / 2));
    x.lines.forEach((l, j) => {
      const want = f.lines[j];
      const row = (message) => add(`baris ${j + 1}: ${message}`);
      if (l.name !== cleanText(want.name) || !l.name.trim()) row("nama barang di XML tidak sama dengan di layar");
      if (!/^\d{6}$/.test(l.code ?? "") || l.code !== want.code) row("kode barang harus 6 angka dan sama dengan di layar");
      if (!/^UM\.\d{4}$/.test(l.unit ?? "") || l.unit !== want.unit) row("satuan harus kode UM.xxxx dan sama dengan di layar");
      if (!(l.qty > 0) || Math.abs(l.qty - want.qty) > 0.00005) row("Qty di XML tidak sama dengan di layar");
      if (l.vatRate !== s.vatRate) row(`tarif PPN harus ${s.vatRate}`);
      for (const [key, label] of LINE_AMOUNTS) {
        if (l[key] == null) row(`${label} kosong atau bukan angka`);
        else if (l[key] !== want[key]) row(`${label} di XML tidak sama dengan di layar`);
      }
      if (LINE_AMOUNTS.some(([key]) => l[key] == null)) return;
      if (l.discountSen < 0) row("Potongan Harga tidak boleh minus");
      if (Math.abs(Math.round(l.priceSen * l.qty) - l.discountSen - l.taxBaseSen) > Math.ceil(l.qty / 2) + slack) {
        row("DPP tidak sama dengan Harga × Qty − Potongan Harga");
      }
      // DPP Nilai Lain = 11/12 × DPP dan PPN = 12% × DPP Nilai Lain, boleh selisih 1 sen karena pembulatan
      if (Math.abs(s.otherBaseDen * l.otherTaxBaseSen - s.otherBaseNum * l.taxBaseSen) > s.otherBaseDen) {
        row(`DPP Nilai Lain tidak sama dengan ${s.otherBaseNum}/${s.otherBaseDen} × DPP`);
      }
      if (Math.abs(100 * l.vatSen - s.vatRate * l.otherTaxBaseSen) > 100) row(`PPN tidak sama dengan ${s.vatRate}% × DPP Nilai Lain`);
    });
    for (const key of ["discountSen", "taxBaseSen", "otherTaxBaseSen", "vatSen"]) {
      if (x.totals[key] !== f.totals[key]) add("total faktur di XML tidak sama dengan rekap");
    }
  });
  return [...new Set(problems)];
}
