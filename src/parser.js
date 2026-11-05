// Membaca PDF "FAKTUR PENJUALAN" (invoice penjualan yang dibuat di Excel lalu disimpan sebagai PDF)
// dari teks PDF (hasil extractPages). Excel bisa memperkecil halaman supaya isinya muat, jadi ukuran dan
// posisi tulisan berbeda-beda per invoice. Karena itu kolom tabel ditentukan dari posisi judul kolomnya
// (QTY, HARGA, DISC, JUMLAH), bukan dari posisi tetap. Satu PDF boleh berisi beberapa invoice.

const TOL = 2; // toleransi posisi, dalam pt

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MEI: 5, MAY: 5, JUN: 6, JUL: 7, AGU: 8, AGS: 8, AGT: 8,
  AUG: 8, SEP: 9, OKT: 10, OCT: 10, NOV: 11, DES: 12, DEC: 12,
};

const HEADER = { qty: "QTY", price: "HARGA", disc: "DISC", total: "JUMLAH" };

const SUMMARY_LABELS = {
  "SUB TOTAL": "subTotal",
  DISCOUNT: "discount",
  DPP: "dpp", // DPP nilai lain (11/12 dari Sub Total)
  PPN: "ppn",
  TOTAL: "total",
};

/** "16.297.000" → 16297000, "2,5" → 2.5. Invoice memakai titik sebagai pemisah ribuan dan koma untuk desimal. */
export function parseNumber(str) {
  const s = str.trim();
  return /^-?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(s) ? Number(s.replace(/\./g, "").replace(",", ".")) : null;
}

/** "09 Oktober 2026" → "2026-10-09" */
export function parseDate(str) {
  const m = /^(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})$/.exec(str.trim());
  const month = m && MONTHS[m[2].slice(0, 3).toUpperCase()];
  return month ? `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}

const sameLine = (a, b) => Math.abs(a.y - b.y) <= TOL;
const center = (it) => it.x + it.w / 2;
const labelOf = (it) => it.str.replace(/\s*:$/, ""); // "TOTAL :" → "TOTAL"
const isRule = (it) => /^=+$/.test(it.str); // garis "=====" pembatas tabel
const valueText = (it) => (it ? it.str.replace(/^:\s*/, "") : "");

/** Teks terdekat di kanan label pada baris yang sama, melewati tanda ":". */
function itemRightOf(items, label) {
  const start = label.x + label.w;
  return items.filter((it) => it.str !== ":" && sameLine(it, label) && it.x > start).sort((a, b) => a.x - b.x)[0] ?? null;
}

const DEFAULT_H = 8; // tinggi huruf (pt) kalau tidak diketahui

/**
 * Kotak (pt, koordinat halaman) yang menutupi teks-teks yang dibaca, untuk ditandai saat PDF ditampilkan:
 * dari atas huruf sampai sedikit di bawah garis dasarnya.
 */
function boxOf(...list) {
  const its = list.filter(Boolean);
  if (!its.length) return null;
  const h = (it) => it.h || DEFAULT_H;
  return {
    x0: Math.min(...its.map((it) => it.x)),
    x1: Math.max(...its.map((it) => it.x + it.w)),
    top: Math.min(...its.map((it) => it.y - 0.85 * h(it))),
    bottom: Math.max(...its.map((it) => it.y + 0.3 * h(it))),
  };
}

const mergeBoxes = (a, b) =>
  !a || !b ? a ?? b : { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };

function findTableHeader(items) {
  const qty = items.find((it) => it.str === HEADER.qty);
  if (!qty) return null;
  const cols = {};
  for (const [key, text] of Object.entries(HEADER)) {
    const it = items.find((o) => o.str === text && sameLine(o, qty));
    if (!it) return null;
    cols[key] = it;
  }
  return { y: qty.y, cols };
}

/**
 * Batas kolom, dibandingkan dengan posisi tengah teks. Angka Qty ada di kiri judul QTY dan satuannya di
 * bawah judul itu; Harga dan Jumlah rata kanan sampai melewati ujung judulnya. Nama barang ada di kiri semuanya.
 */
function columnBounds({ qty, price, disc, total }) {
  const between = (a, b) => (a.x + a.w + b.x) / 2;
  return { name: qty.x - 2 * qty.w, price: between(qty, price), disc: between(price, disc), total: between(disc, total) };
}

function columnOf(it, bounds) {
  const c = center(it);
  if (c < bounds.name) return "name";
  if (c < bounds.price) return "qtyUnit";
  if (c < bounds.disc) return "price";
  if (c < bounds.total) return "disc";
  return "total";
}

/** ["19", "BTG"] → Qty 19, satuan BTG. Teks lain di kolom itu adalah sambungan nama barang yang panjang. */
function splitQtyUnit(tokens) {
  const unitAt = tokens.findLastIndex((t) => parseNumber(t) == null);
  const qtyAt = tokens.findLastIndex((t, i) => (unitAt < 0 || i < unitAt) && parseNumber(t) != null);
  return {
    qty: qtyAt < 0 ? null : parseNumber(tokens[qtyAt]),
    unit: unitAt < 0 ? "" : tokens[unitAt].toUpperCase(),
    rest: tokens.filter((_, i) => i !== qtyAt && i !== unitAt),
  };
}

function parseRows(items, header, bottomY, warnings) {
  const body = items
    .filter((it) => !isRule(it) && it.y > header.y + TOL && it.y < bottomY - TOL)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const lines = [];
  for (const it of body) {
    const last = lines.at(-1);
    if (last && it.y - last.y <= TOL) last.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }

  const bounds = columnBounds(header.cols);
  const rows = [];
  const loose = []; // baris yang hanya berisi nama: nama barang yang tertulis lebih dari satu baris
  for (const line of lines) {
    const cells = { name: [], qtyUnit: [], price: [], disc: [], total: [] };
    for (const it of line.items.sort((a, b) => a.x - b.x)) cells[columnOf(it, bounds)].push(it.str);
    const text = (key) => cells[key].join(" ");

    if (!cells.qtyUnit.length && !cells.price.length && !cells.total.length) {
      if (cells.name.length && !cells.disc.length) loose.push({ y: line.y, text: text("name"), box: boxOf(...line.items) });
      else warnings.push(`baris tabel tidak dikenali: "${line.items.map((it) => it.str).join(" ")}"`);
      continue;
    }

    const { qty, unit, rest } = splitQtyUnit(cells.qtyUnit.flatMap((s) => s.split(/\s+/)));
    const row = {
      y: line.y,
      box: boxOf(...line.items),
      name: [...cells.name, ...rest].join(" "),
      qty,
      unit,
      price: parseNumber(text("price")),
      disc: text("disc").replace(/^-$/, ""),
      total: parseNumber(text("total")),
    };
    for (const [key, label, cell] of [["qty", "Qty", "qtyUnit"], ["price", "Harga", "price"], ["total", "Jumlah", "total"]]) {
      if (row[key] == null) warnings.push(`baris "${row.name}": kolom ${label} tidak terbaca ("${text(cell)}")`);
    }
    if (!row.unit) warnings.push(`baris "${row.name}": satuan tidak terbaca`);
    rows.push(row);
  }

  // Sambungkan ke baris barang terdekat; kalau jaraknya sama, ke baris di bawahnya (Excel menaruh angka
  // sejajar baris terbawah nama yang turun ke bawah).
  for (const part of loose) {
    let best = null;
    for (const row of rows) {
      const d = Math.abs(row.y - part.y);
      if (!best || d < best.d - 0.5 || (Math.abs(d - best.d) <= 0.5 && row.y > part.y)) best = { row, d };
    }
    if (!best) {
      warnings.push(`teks di tabel tanpa baris barang: "${part.text}"`);
      continue;
    }
    best.row.name = best.row.y > part.y ? `${part.text} ${best.row.name}` : `${best.row.name} ${part.text}`;
    best.row.box = mergeBoxes(best.row.box, part.box);
    warnings.push(`nama barang "${best.row.name}" tertulis lebih dari satu baris, cek apakah sudah benar`);
  }
  return rows;
}

function parseSummary(items, fromY, boxes) {
  const summary = {};
  for (const [text, key] of Object.entries(SUMMARY_LABELS)) {
    const label = items.find((it) => it.y > fromY && labelOf(it) === text);
    if (!label) continue;
    const value = items
      .filter((it) => it.x > label.x + label.w && Math.abs(it.y - label.y) <= 3 && (it.str === "-" || parseNumber(it.str) != null))
      .sort((a, b) => b.x - a.x)[0];
    if (value) {
      summary[key] = value.str === "-" ? 0 : parseNumber(value.str);
      boxes[key] = boxOf(label, value);
    }
  }
  return Object.keys(summary).length ? summary : null;
}

/** NPWP pembeli tercetak di bawah alamat: "NPWP : " lalu 16 angka. */
function findNpwp(items, fromY, toY, boxes) {
  const label = items.find((it) => /^NPWP\b/i.test(it.str) && it.y > fromY - TOL && it.y < toY);
  if (!label) return "";
  const inline = label.str.replace(/^NPWP\s*:?\s*/i, "");
  const value = /\d/.test(inline) ? null : itemRightOf(items, label);
  boxes.npwp = boxOf(label, value);
  return (/\d/.test(inline) ? inline : valueText(value)).trim();
}

/** Nama penjual: baris paling atas di kop invoice. */
function findSeller(items, untilY) {
  return (
    items
      .filter((it) => it.y < untilY - TOL && !/^FAKTUR PENJUALAN$/i.test(it.str))
      .sort((a, b) => a.y - b.y || a.x - b.x)[0]?.str ?? ""
  );
}

function parsePage(page) {
  const { items } = page;
  const find = (text) => items.find((it) => labelOf(it) === text) ?? null;
  const warnings = [];
  const header = findTableHeader(items);
  if (!header) warnings.push("judul kolom tabel (QTY, HARGA, DISC, JUMLAH) tidak ditemukan");

  const numberLabel = find("Penjualan");
  const dateLabel = find("Tanggal");
  const customerLabel = find("Customer");
  // Posisi teks yang dibaca, untuk ditandai saat PDF ditampilkan di aplikasi
  const marks = { header: {}, summary: {} };
  const valueOf = (key, label) => {
    if (!label) return "";
    const value = itemRightOf(items, label);
    marks.header[key] = boxOf(label, value);
    return valueText(value);
  };

  const number = valueOf("number", numberLabel);
  const dateText = valueOf("date", dateLabel);
  const date = dateText ? parseDate(dateText) : null;
  if (!dateText) warnings.push("tanggal invoice tidak ditemukan");
  else if (!date) warnings.push(`tanggal tidak terbaca: "${dateText}"`);

  // "S0024-PT. CONTOH JAYA": kode pelanggan di depan nama
  const customer = valueOf("customer", customerLabel);
  const named = /^([A-Z]\d{3,5})\s*-\s*(.+)$/.exec(customer);

  const subTotalLabel = items.find((it) => labelOf(it) === "SUB TOTAL" && (!header || it.y > header.y));

  return {
    page: page.number,
    number,
    date,
    seller: findSeller(items, numberLabel?.y ?? header?.y ?? Infinity),
    buyerCode: named?.[1] ?? "",
    buyerName: named?.[2] ?? customer,
    buyerNpwp: findNpwp(items, customerLabel?.y ?? 0, header?.y ?? Infinity, marks.header),
    rows: header ? parseRows(items, header, subTotalLabel?.y ?? Infinity, warnings) : [],
    summary: header ? parseSummary(items, header.y, marks.summary) : null,
    marks,
    warnings,
  };
}

/**
 * Ubah halaman-halaman PDF menjadi daftar invoice. Satu PDF boleh berisi beberapa invoice;
 * halaman dikelompokkan menurut nomor invoice.
 */
export function parseInvoices(pages) {
  const warnings = [];
  const groups = new Map();
  for (const page of pages) {
    const parsed = parsePage(page);
    if (!parsed.number) {
      warnings.push(`Halaman ${page.number} dilewati: nomor invoice tidak ditemukan`);
      continue;
    }
    if (!groups.has(parsed.number)) groups.set(parsed.number, []);
    groups.get(parsed.number).push(parsed);
  }

  const invoices = [];
  // Kotak teks yang dibaca, diberi nomor halaman: { page, x0, x1, top, bottom } dalam pt
  const onPage = (page, boxes) => Object.fromEntries(Object.entries(boxes).filter(([, b]) => b).map(([key, b]) => [key, { page, ...b }]));
  for (const [number, parts] of groups) {
    const { date, seller, buyerCode, buyerName, buyerNpwp } = parts[0];
    const marks = { header: onPage(parts[0].page, parts[0].marks.header), lines: [], summary: {} };
    const invoice = { number, date, seller, buyerCode, buyerName, buyerNpwp, pages: [], lines: [], summary: null, warnings: [], marks };
    for (const part of parts) {
      const where = parts.length > 1 ? `Hal. ${part.page}: ` : "";
      invoice.pages.push(part.page);
      for (const { y, box, ...row } of part.rows) {
        invoice.lines.push(row);
        marks.lines.push(box && { page: part.page, ...box });
      }
      if (part.summary && invoice.summary) invoice.warnings.push(`${where}ringkasan invoice ini muncul lebih dari sekali, mungkin halamannya dobel`);
      if (part.summary) {
        invoice.summary = part.summary;
        marks.summary = onPage(part.page, part.marks.summary);
      }
      invoice.warnings.push(...part.warnings.map((w) => where + w));
    }
    invoice.lines.forEach((line, i) => {
      line.no = i + 1;
      line.name = line.name.replace(/\s+/g, " ").trim();
    });
    invoices.push(invoice);
  }
  return { invoices, warnings };
}
