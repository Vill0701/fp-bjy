// Menyusun XML "TaxInvoiceBulk" untuk impor faktur pajak keluaran di Coretax.
// Formatnya disamakan dengan file buatan pengguna: BOM UTF-8, baris CRLF, indentasi 2 spasi.
import { DEFAULT_SETTINGS } from "./calc.js";
import { formatQty, formatSen } from "./money.js";

const escapeXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
