// Menghitung isi faktur (DPP, DPP Nilai Lain, PPN) dari invoice yang sudah dibaca,
// sekaligus semua pengecekan yang hasilnya ditampilkan ke pengguna.
//
// Cara hitungnya mengikuti template Excel pengguna: harga jual = harga termasuk PPN ÷ 1,11, lalu DPP,
// DPP Nilai Lain, dan PPN tiap baris dihitung tanpa pembulatan dan baru dibulatkan ke sen di akhir.
// Invoice hanya mencetak harga yang sudah dibagi 1,11 dan dibulatkan ke rupiah, jadi harga termasuk PPN
// dihitung balik dari kolom Harga dan Jumlah. Untuk harga bulat (mis. 230.000) hasilnya sama persis
// dengan angka di invoice.
import { ratio, rupiah, toSen } from "./money.js";
import { normalizeNitku, normalizeNpwp } from "./npwp.js";
import { parseNumber } from "./parser.js";
import { normalizeUnit } from "./satuan.js";

export const DEFAULT_SETTINGS = {
  trxCode: "04",
  opt: "A",
  goodsCode: "720000", // Besi dan baja
  buyerName: "KONGSO PPN", // nama & alamat asli diisi otomatis oleh Coretax dari NPWP pembeli
  buyerAddress: "BEKASI",
  buyerEmail: "-",
  vatRate: 12, // PPN = 12% dari DPP Nilai Lain
  otherBaseNum: 11, // DPP Nilai Lain = 11/12 dari harga jual
  otherBaseDen: 12,
  sellerName: "", // nama penjual di kop invoice; kosong = tidak dicek
};

/** Kunci pencocokan nama barang atau penjual: huruf besar, spasi tunggal. */
export const nameKey = (name) => String(name ?? "").toUpperCase().replace(/\s+/g, " ").trim();

/** Harga termasuk PPN = harga jual × num ÷ den (1332 ÷ 1200 = 1,11). */
function inclusiveFactor(s) {
  const den = s.otherBaseDen * 100;
  return { num: den + s.vatRate * s.otherBaseNum, den };
}

/** Qty sebagai pecahan bilangan bulat: 2,5 → [25000, 10000]. */
const qtyFraction = (qty) => [Math.round(qty * 10000), 10000];

const trailingZeros = (n) => {
  let zeros = 0;
  for (; n && n % 10 === 0; n /= 10) zeros++;
  return zeros;
};

/**
 * Harga satuan termasuk PPN (rupiah bulat) yang menghasilkan kolom Harga dan Jumlah di invoice:
 * harga ÷ 1,11 dibulatkan = Harga, dan Qty × harga ÷ 1,11 dibulatkan = Jumlah. Kalau ada dua kandidat,
 * dipilih yang paling bulat, karena harga dari penjual biasanya kelipatan 1.000. Null kalau tidak ada
 * kandidat yang berakhiran 0: berarti harga di invoice memang harga sebelum PPN.
 */
export function inclusiveUnitPrice(price, qty, total, settings = DEFAULT_SETTINGS) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  if (!Number.isInteger(price) || !Number.isInteger(total) || !(qty > 0)) return null;
  const f = inclusiveFactor(s);
  const [qn, qd] = qtyFraction(qty);
  const big = (n) => BigInt(n);
  let best = null;
  const lo = Math.floor(((2 * price - 1) * f.num) / (2 * f.den));
  const hi = Math.ceil(((2 * price + 1) * f.num) / (2 * f.den));
  for (let u = lo; u <= hi; u++) {
    // |u × den/num − Harga| ≤ ½  dan  |Qty × u × den/num − Jumlah| ≤ ½
    const unitOff = Math.abs(2 * f.den * u - 2 * f.num * price);
    const lineOff = big(2 * f.den) * big(qn) * big(u) - big(2 * f.num) * big(qd) * big(total);
    if (unitOff > f.num || (lineOff < 0n ? -lineOff : lineOff) > big(f.num) * big(qd)) continue;
    const score = [trailingZeros(u), -unitOff];
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) best = { u, score };
  }
  return best && best.score[0] > 0 ? best.u : null;
}

/** DPP, DPP Nilai Lain, dan PPN dari DPP eksak num ÷ den (dalam sen), masing-masing dibulatkan ke sen. */
function amounts(num, den, s) {
  return {
    taxBaseSen: ratio([num], [den]),
    otherTaxBaseSen: ratio([num, s.otherBaseNum], [den, s.otherBaseDen]),
    vatSen: ratio([num, s.otherBaseNum, s.vatRate], [den, s.otherBaseDen, 100]),
  };
}

/**
 * Tentukan dari angka PPN di invoice apakah harga barang belum atau sudah termasuk PPN.
 * Belum termasuk: PPN = 12% × 11/12 × dasar = 11% × dasar. Sudah termasuk: PPN = 11/111 × dasar.
 * Dasar = Sub Total − Diskon.
 */
export function detectVatMode(summary, lineCount, settings = DEFAULT_SETTINGS) {
  const { subTotal = 0, discount = 0, ppn = 0 } = summary ?? {};
  const rateNum = settings.vatRate * settings.otherBaseNum; // 132
  const rateDen = settings.otherBaseDen * 100; // 1200 → 132/1200 = 11%
  const tolerance = Math.max(1, Math.ceil(lineCount / 2)); // selisih pembulatan per baris
  const base = subTotal - discount;
  if (base > 0) {
    if (Math.abs(ppn - (base * rateNum) / rateDen) <= tolerance) return "exclusive";
    if (Math.abs(ppn - (base * rateNum) / (rateDen + rateNum)) <= tolerance) return "inclusive";
  }
  return "unknown";
}

/** Bagi `amountSen` ke tiap baris sesuai bobotnya; sisa pembulatan masuk ke baris terbesar. */
export function allocate(amountSen, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!amountSen || !total) return weights.map(() => 0);
  const unit = amountSen % 100 === 0 ? 100 : 1; // dibagi per rupiah penuh kalau bisa
  const parts = weights.map((w) => ratio([amountSen / unit, w], [total]) * unit);
  parts[weights.indexOf(Math.max(...weights))] += amountSen - parts.reduce((a, b) => a + b, 0);
  return parts;
}

/** Apakah kolom Disc cocok dengan selisih Qty × Harga − Jumlah (rupiah per baris, per unit, atau persen). */
function discountColumnMatches(line, lineDiscSen) {
  const text = line.disc.trim();
  const isPercent = text.endsWith("%");
  const value = parseNumber(isPercent ? text.slice(0, -1) : text);
  if (value == null) return false;
  const gross = Math.round(line.qty * line.price * 100);
  const candidates = isPercent
    ? [Math.round((gross * value) / 100)]
    : [toSen(value), Math.round(toSen(value) * line.qty), Math.round((gross * value) / 100)];
  return candidates.some((c) => Math.abs(c - lineDiscSen) <= 100);
}

/**
 * Susun satu faktur dari satu invoice.
 * data = { items: { [nameKey]: { coretaxCode, unit } }, units: { [satuanInvoice]: "UM.xxxx" } }
 * invoice.override = { npwp, nitku, trxCode } kalau data pembeli diisi manual untuk invoice ini.
 */
export function computeFaktur(invoice, data, settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const checks = [];
  const check = (level, message) => checks.push({ level, message });
  const sum = { subTotal: 0, discount: 0, ppn: 0, total: 0, ...invoice.summary };
  const lines = invoice.lines;

  for (const w of invoice.warnings) check("warn", w);

  // 1. Invoice dari penjual yang benar dan lengkap
  if (s.sellerName && invoice.seller && nameKey(invoice.seller) !== nameKey(s.sellerName)) {
    check("error", `Invoice ini dari ${invoice.seller}, bukan ${s.sellerName}. Kalau nama penjualnya memang berubah, ganti di Pengaturan.`);
  }
  if (!invoice.date) check("error", "Tanggal invoice tidak terbaca");
  if (!invoice.summary) check("error", "Ringkasan (Sub Total, PPN, Total) tidak ditemukan");
  if (!lines.length) check("error", "Tidak ada baris barang yang terbaca");

  // 2. Jumlah semua baris sama dengan Sub Total
  const linesTotal = lines.reduce((a, l) => a + toSen(l.total ?? 0), 0);
  if (invoice.summary && lines.length) {
    if (linesTotal !== toSen(sum.subTotal)) {
      check("error", `Jumlah semua baris (${rupiah(linesTotal)}) tidak sama dengan Sub Total (${rupiah(toSen(sum.subTotal))})`);
    } else {
      check("ok", `Jumlah ${lines.length} baris barang sama dengan Sub Total`);
    }
  }

  // 3. Qty × Harga = Jumlah, kecuali selisih karena Harga dibulatkan ke rupiah, atau ada diskon per baris
  const hasLineDiscount = lines.some((l) => l.disc.trim() && parseNumber(l.disc.trim().replace(/%$/, "")) !== 0);
  for (const l of lines) {
    if (l.qty == null || l.price == null || l.total == null) continue; // sudah diperingatkan saat membaca PDF
    const grossSen = Math.round(l.qty * l.price * 100);
    const diffSen = grossSen - toSen(l.total);
    if (l.disc.trim()) {
      if (diffSen < 0) check("error", `Baris ${l.no}: Jumlah lebih besar dari Qty × Harga`);
      else if (!discountColumnMatches(l, diffSen)) {
        check("warn", `Baris ${l.no}: kolom Disc (${l.disc}) tidak cocok dengan selisih harga (${rupiah(diffSen)})`);
      }
    } else if (Math.abs(diffSen) > Math.ceil(l.qty * 50) + 50) {
      check("warn", `Baris ${l.no}: Qty × Harga (${rupiah(grossSen)}) tidak sama dengan Jumlah (${rupiah(toSen(l.total))})`);
    }
  }

  // 4. Harga belum / sudah termasuk PPN
  const mode = invoice.summary ? detectVatMode(sum, lines.length, s) : "unknown";
  const hasDiscount = hasLineDiscount || sum.discount > 0;
  if (mode === "exclusive") check("ok", "Harga di invoice belum termasuk PPN (PPN = 11% × Sub Total)");
  else if (mode === "inclusive") check("info", "Harga di invoice sudah termasuk PPN");
  else if (invoice.summary) check("error", "PPN di invoice tidak cocok dengan rumus harga belum maupun sudah termasuk PPN, perlu dicek manual");
  if (mode === "inclusive" && hasDiscount) check("error", "Invoice dengan harga termasuk PPN dan diskon belum didukung. Buat fakturnya manual.");
  else if (hasDiscount) check("warn", "Invoice ini berdiskon. Belum ada contoh invoice berdiskon, jadi cek lagi angka potongan harganya.");
  if (invoice.summary) {
    const expectedTotal = sum.subTotal - sum.discount + (mode === "inclusive" ? 0 : sum.ppn);
    if (Math.abs(expectedTotal - sum.total) > 1) {
      check("warn", `Total invoice (${rupiah(toSen(sum.total))}) tidak sama dengan perhitungan (${rupiah(toSen(expectedTotal))})`);
    }
  }

  // 5. Baris faktur
  const f = inclusiveFactor(s);
  const allocated = allocate(toSen(sum.discount), lines.map((l) => toSen(l.total ?? 0)));
  let rebuilt = null; // contoh harga yang dihitung balik dari harga termasuk PPN
  const fakturLines = lines.map((l, i) => {
    const qty = l.qty ?? 0;
    const totalSen = toSen(l.total ?? 0);
    const [qn, qd] = qtyFraction(qty);
    let priceSen;
    let discountSen = 0;
    let exact; // DPP eksak = exact[0] ÷ exact[1] sen
    let unitInclusive = null;
    if (mode === "inclusive" && !hasDiscount) {
      // Jumlah di invoice sudah termasuk PPN
      exact = [BigInt(totalSen) * BigInt(f.den), f.num];
      priceSen = qn ? ratio([totalSen, f.den, qd], [f.num, qn]) : 0;
    } else if (!hasDiscount && (unitInclusive = inclusiveUnitPrice(l.price, qty, l.total, s)) != null) {
      exact = [BigInt(qn) * BigInt(unitInclusive * 100) * BigInt(f.den), BigInt(qd) * BigInt(f.num)];
      priceSen = ratio([unitInclusive * 100, f.den], [f.num]);
    } else {
      // Angka invoice apa adanya; diskon per baris dan diskon invoice menjadi potongan harga.
      const grossSen = Math.round(qty * (l.price ?? 0) * 100);
      if (hasDiscount) {
        priceSen = toSen(l.price ?? 0);
        discountSen = grossSen - totalSen + allocated[i];
        exact = [grossSen - discountSen, 1];
      } else {
        priceSen = grossSen === totalSen || !qn ? toSen(l.price ?? 0) : ratio([totalSen, qd], [qn]);
        exact = [totalSen, 1];
      }
    }
    const a = amounts(exact[0], exact[1], s);
    if (unitInclusive != null && !rebuilt && a.taxBaseSen !== totalSen) rebuilt = { unitInclusive, priceSen };

    const key = nameKey(l.name);
    const item = data.items?.[key] ?? {};
    return {
      key,
      name: l.name,
      invoiceUnit: l.unit,
      qty,
      priceSen,
      discountSen,
      unitInclusive,
      opt: s.opt,
      code: item.coretaxCode || s.goodsCode,
      unit: item.unit || data.units?.[normalizeUnit(l.unit ?? "")] || "",
      ...a,
    };
  });
  if (rebuilt) {
    check("info", `Harga dihitung dari harga termasuk PPN, seperti di template Excel (mis. ${rupiah(rebuilt.unitInclusive * 100)} ÷ 1,11 = ${rupiah(rebuilt.priceSen)})`);
  }

  const totals = {
    taxBaseSen: fakturLines.reduce((a, l) => a + l.taxBaseSen, 0),
    otherTaxBaseSen: fakturLines.reduce((a, l) => a + l.otherTaxBaseSen, 0),
    vatSen: fakturLines.reduce((a, l) => a + l.vatSen, 0),
  };

  // 6. Total faktur, dibulatkan ke rupiah seperti di faktur Coretax, harus sama dengan invoice
  if (invoice.summary && mode !== "unknown" && lines.length) {
    const compared = [
      ["DPP", totals.taxBaseSen, mode === "inclusive" ? null : sum.subTotal - sum.discount],
      ["DPP Nilai Lain", totals.otherTaxBaseSen, invoice.summary.dpp ?? null],
      ["PPN", totals.vatSen, sum.ppn],
    ]
      .filter(([, , want]) => want != null)
      .map(([label, sen, want]) => ({ label, sen, want, diff: Math.round(sen / 100) - want }));
    if (compared.every((c) => c.diff === 0)) {
      const labels = compared.map((c) => c.label);
      const listed = labels.length < 3 ? labels.join(" dan ") : `${labels.slice(0, -1).join(", ")}, dan ${labels.at(-1)}`;
      check("ok", `${listed} faktur sama dengan invoice (setelah dibulatkan ke rupiah)`);
    }
    for (const c of compared.filter((c) => c.diff)) {
      check(Math.abs(c.diff) <= 1 ? "info" : "warn", `${c.label} faktur ${rupiah(c.sen)}, beda ${rupiah(c.diff * 100)} dari invoice (${rupiah(c.want * 100)})`);
    }
  }

  // 7. Pembeli, kode barang, satuan
  const override = invoice.override ?? {};
  const rawNpwp = override.npwp ?? invoice.buyerNpwp ?? "";
  const npwp = normalizeNpwp(rawNpwp);
  const nitku = npwp && normalizeNitku(override.nitku, npwp);
  const buyer = npwp && !/^0+$/.test(npwp) && nitku ? { npwp, nitku } : null;
  if (!rawNpwp) check("error", "NPWP pembeli tidak ada di invoice. Isi manual.");
  else if (!buyer) check("error", `NPWP pembeli di invoice tidak valid ("${rawNpwp}"). Isi manual.`);
  const noCode = fakturLines.filter((l) => !/^\d{6}$/.test(l.code)).length;
  const noUnit = fakturLines.filter((l) => !/^UM\.\d{4}$/.test(l.unit)).length;
  if (noCode) check("error", `Kode barang Coretax belum diisi untuk ${noCode} baris`);
  if (noUnit) check("error", `Satuan Coretax belum diisi untuk ${noUnit} baris`);

  return {
    number: invoice.number,
    date: invoice.date,
    buyerName: invoice.buyerName,
    buyer,
    trxCode: override.trxCode || s.trxCode,
    vatMode: mode,
    lines: fakturLines,
    totals,
    checks,
    ready: !checks.some((c) => c.level === "error"),
  };
}
