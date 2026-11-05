// Uji dengan file contoh asli. File contoh berisi NPWP dan nama pelanggan, jadi hanya ada di laptop:
// folder contoh/ tidak ikut di-upload, dan kode tes ini tidak boleh memuat data itu. Patokannya:
// - PDF faktur Coretax yang sudah terbit untuk invoice yang sama (dicocokkan lewat "Referensi: J…");
// - XML buatan pengguna dari template Excel (contoh/*.xml), yang harus bisa dibuat ulang byte demi byte;
// - nilai yang sudah diperiksa di contoh/harapan.json.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { computeFaktur, nameKey } from "../src/calc.js";
import { parseInvoices } from "../src/parser.js";
import { extractPages } from "../src/pdf-text.js";
import { DEFAULT_UNITS, UNIT_NAMES } from "../src/satuan.js";
import { buildXml, verifyXml } from "../src/xml.js";

const root = fileURLToPath(new URL("../contoh/", import.meta.url));
const skip = !existsSync(root) && "folder contoh/ tidak ada";
const data = { items: {}, units: DEFAULT_UNITS };
const problems = (f) => f.checks.filter((c) => c.level === "error" || c.level === "warn").map((c) => c.message);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** "81.081,08" → 8108108 sen */
const senOf = (text) => Math.round(Number(text.replace(/\./g, "").replace(",", ".")) * 100);

/** Baris teks per halaman: potongan teks yang sejajar digabung dengan spasi. */
function textLines(pages) {
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

const unitCodes = Object.fromEntries(Object.entries(UNIT_NAMES).map(([code, name]) => [name, code]));

/** Isi satu faktur pajak Coretax (baris-baris teksnya): baris barang dan total. */
function readCoretaxFaktur(lines, ref) {
  const goods = [];
  lines.forEach((line, i) => {
    const m = /^Rp ([\d.,]+) x ([\d.,]+) (.+)$/.exec(line);
    if (!m) return;
    const [, no, code, taxBase] = /^(\d+) (\d{6}) ([\d.,]+)$/.exec(lines[i + 1]);
    goods.push({ no: Number(no), name: lines[i - 1], priceSen: senOf(m[1]), qty: senOf(m[2]) / 100, unit: unitCodes[m[3]], code, taxBaseSen: senOf(taxBase) });
  });
  const total = (label) => senOf(lines.find((l) => l.startsWith(label)).slice(label.length).trim());
  return {
    ref,
    text: lines.join("\n"),
    goods,
    taxBaseSen: total("Harga Jual / Penggantian / Uang Muka / Termin"),
    otherTaxBaseSen: total("Dasar Pengenaan Pajak"),
    vatSen: total("Jumlah PPN (Pajak Pertambahan Nilai)"),
  };
}

/** Faktur pajak Coretax di sebuah PDF (bisa beberapa); tiap faktur diakhiri baris "(Referensi: …)". */
function readCoretaxFakturs(pages) {
  const lines = textLines(pages);
  if (!lines.some((l) => l.startsWith("Kode dan Nomor Seri Faktur Pajak"))) return [];
  const fakturs = [];
  let start = 0;
  lines.forEach((line, i) => {
    const ref = /\(Referensi: (.+)\)/.exec(line)?.[1];
    if (!ref) return;
    fakturs.push(readCoretaxFaktur(lines.slice(start, i + 1), ref));
    start = i + 1;
  });
  return fakturs;
}

// Semua PDF di contoh/: invoice dan faktur pajak Coretax.
async function readSamples() {
  const invoices = new Map(); // nomor → [{ file, invoice }]
  const fakturs = []; // isi faktur pajak, termasuk yang sama di PDF gabungan
  for (const path of walk(root)) {
    if (!/\.pdf$/i.test(path)) continue;
    const pages = await extractPages(pdfjs, new Uint8Array(readFileSync(path)));
    const found = readCoretaxFakturs(pages);
    if (found.length) {
      fakturs.push(...found);
      continue;
    }
    for (const invoice of parseInvoices(pages).invoices) {
      if (!invoices.has(invoice.number)) invoices.set(invoice.number, []);
      invoices.get(invoice.number).push({ file: path, invoice });
    }
  }
  return { invoices, fakturs };
}

const samples = skip ? null : readSamples();

test("invoice sama dengan faktur Coretax yang sudah terbit, baris demi baris", { skip }, async (t) => {
  const { invoices, fakturs } = await samples;
  assert.ok(fakturs.length > 0, "tidak ada PDF faktur Coretax di contoh/");
  t.diagnostic(`${fakturs.length} faktur Coretax dicocokkan (${new Set(fakturs.map((f) => f.ref)).size} invoice)`);
  for (const want of fakturs) {
    const { ref } = want;
    assert.ok(invoices.has(ref), `PDF invoice ${ref} tidak ada`);
    const f = computeFaktur(invoices.get(ref)[0].invoice, data);
    assert.deepEqual(problems(f), [], ref);
    assert.ok(f.ready, ref);
    assert.deepEqual(
      f.lines.map((l, i) => ({ no: i + 1, name: l.name, priceSen: l.priceSen, qty: l.qty, unit: l.unit, code: l.code, taxBaseSen: l.taxBaseSen })),
      want.goods,
      ref,
    );
    // Total di faktur Coretax dibulatkan ke rupiah.
    const rp = (sen) => Math.round(sen / 100) * 100;
    assert.deepEqual(
      [rp(f.totals.taxBaseSen), rp(f.totals.otherTaxBaseSen), rp(f.totals.vatSen)],
      [want.taxBaseSen, want.otherTaxBaseSen, want.vatSen],
      ref,
    );
    assert.ok(want.text.includes(`#${f.buyer.nitku}`), `${ref}: NITKU pembeli beda dengan faktur`);
  }
});

test("invoice yang sama di PDF gabungan dan PDF tersendiri terbaca sama", { skip }, async () => {
  const { invoices } = await samples;
  for (const [number, copies] of invoices) {
    for (const { file, invoice } of copies.slice(1)) {
      const { pages: _a, marks: _c, ...first } = copies[0].invoice;
      const { pages: _b, marks: _d, ...other } = invoice;
      assert.deepEqual(other, first, `${number} di ${file}`);
    }
  }
});

test("tanda bagian yang dibaca ada di dalam halaman PDF asli, satu per baris barang", { skip }, async () => {
  const { invoices } = await samples;
  for (const [number, [{ invoice }]] of invoices) {
    const { header, lines, summary } = invoice.marks;
    assert.deepEqual(Object.keys(header), ["number", "date", "customer", "npwp"], number);
    assert.deepEqual(Object.keys(summary), Object.keys(invoice.summary), number);
    assert.equal(lines.length, invoice.lines.length, number);
    const all = [...Object.values(header), ...lines, ...Object.values(summary)];
    for (const m of all) {
      assert.ok(invoice.pages.includes(m.page), `${number}: halaman ${m.page}`);
      // Halaman invoice A5 mendatar: 595 × 420 pt
      assert.ok(m.x0 >= 0 && m.x1 <= 596 && m.top >= 0 && m.bottom <= 420 && m.x0 < m.x1 && m.top < m.bottom, `${number}: ${JSON.stringify(m)}`);
    }
    // Baris barang berurutan dari atas ke bawah dan tidak bertumpuk
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].page === lines[i - 1].page) assert.ok(lines[i - 1].bottom <= lines[i].top + 0.5, `${number}: baris ${i} dan ${i + 1}`);
    }
  }
});

test("isi PDF contoh terbaca sesuai nilai yang sudah diperiksa", { skip }, async (t) => {
  const file = join(root, "harapan.json");
  if (!existsSync(file)) return t.skip("contoh/harapan.json tidak ada");
  const { invoices } = await samples;
  const checked = [];
  for (const want of JSON.parse(readFileSync(file, "utf8")).invoices) {
    if (!invoices.has(want.number)) {
      t.diagnostic(`${want.number}: PDF-nya belum ada di contoh/, dilewati`);
      continue;
    }
    const inv = invoices.get(want.number)[0].invoice;
    assert.deepEqual(inv.warnings, [], want.number);
    assert.deepEqual(
      {
        date: inv.date,
        seller: inv.seller,
        buyerCode: inv.buyerCode,
        buyerName: inv.buyerName,
        buyerNpwp: inv.buyerNpwp,
        summary: inv.summary,
        lines: inv.lines.map((l) => [l.name, l.qty, l.unit, l.price, l.disc, l.total]),
      },
      {
        date: want.date,
        seller: want.seller,
        buyerCode: want.buyerCode,
        buyerName: want.buyerName,
        buyerNpwp: want.buyerNpwp,
        summary: want.summary,
        lines: want.lines,
      },
      want.number,
    );
    const f = computeFaktur(inv, data, { sellerName: want.seller });
    assert.deepEqual(problems(f), [], want.number);
    assert.ok(f.ready, want.number);
    if (want.faktur) {
      assert.deepEqual(
        Object.fromEntries(Object.keys(want.faktur).map((key) => [key, f.lines.map((l) => l[key])])),
        want.faktur,
        want.number,
      );
    }
    // Pilihan cara hitung yang ditampilkan: [pilihan, berapa total yang sama dengan invoice]
    assert.deepEqual(f.options.map((o) => [o.key, o.matches]), want.options ?? [], want.number);
    assert.equal(f.choice, want.choice ?? "template", want.number);
    checked.push(f);
  }
  // Semua invoice contoh dalam satu XML lolos pemeriksaan sebelum download (penjual tiruan, bukan NPWP asli)
  const tin = "0" + "9".repeat(15);
  const seller = { tin, idtku: tin + "000000" };
  assert.deepEqual(verifyXml(buildXml(seller, checked), seller, checked), []);
});

// Pembacaan XML sederhana (tanpa DOM parser), cukup untuk file contoh.
const tag = (xml, name) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? "";
const blocks = (xml, name) => xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, "g")) ?? [];
const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("XML buatan pengguna dari template Excel bisa dibuat ulang persis", { skip }, () => {
  const files = readdirSync(root).filter((name) => /\.xml$/i.test(name));
  assert.ok(files.length > 0, "tidak ada XML contoh");
  for (const name of files) {
    const expected = readFileSync(join(root, name));
    const xml = expected.toString("utf8");
    const items = {};
    // Invoice disusun ulang seperti yang dicetak Excel penjual: Harga dan Jumlah dibulatkan ke rupiah, sedangkan
    // Sub Total, DPP (11/12), dan PPN (11%) dihitung dari Jumlah sebelum dibulatkan, lalu dibulatkan.
    const invoices = blocks(xml, "TaxInvoice").map((block) => {
      const exactSen = blocks(block, "GoodService").reduce((a, gs) => a + Math.round(Number(tag(gs, "TaxBase")) * 100), 0);
      const lines = blocks(block, "GoodService").map((gs, i) => {
        const lineName = unescapeXml(tag(gs, "Name"));
        if (tag(gs, "Code") !== "720000") items[nameKey(lineName)] = { coretaxCode: tag(gs, "Code") };
        return {
          no: i + 1,
          name: lineName,
          qty: Number(tag(gs, "Qty")),
          unit: tag(gs, "Unit") === "UM.0020" ? "LBR" : "BTG",
          price: Math.round(Number(tag(gs, "Price"))),
          disc: "",
          total: Math.round(Number(tag(gs, "TaxBase"))),
        };
      });
      const subTotal = Math.round(exactSen / 100);
      const ppn = Math.round((exactSen * 11) / 10000);
      return {
        number: tag(block, "RefDesc"),
        date: tag(block, "TaxInvoiceDate"),
        seller: "",
        buyerName: "",
        buyerNpwp: tag(block, "BuyerTin"),
        lines,
        summary: { subTotal, discount: 0, dpp: Math.round((exactSen * 11) / 1200), ppn, total: subTotal + ppn },
        warnings: [],
      };
    });
    const fakturs = invoices.map((inv) => computeFaktur(inv, { items, units: DEFAULT_UNITS }));
    for (const f of fakturs) assert.deepEqual(f.checks.filter((c) => c.level === "error").map((c) => c.message), [], f.number);
    const seller = { tin: tag(xml, "TIN"), idtku: tag(xml, "SellerIDTKU") };
    const out = buildXml(seller, fakturs);
    assert.equal(out, xml, name);
    assert.ok(Buffer.from(out, "utf8").equals(expected), `isi byte ${name} berbeda`);
    // XML buatan pengguna yang sudah diterima Coretax juga lolos pemeriksaan sebelum download
    assert.deepEqual(verifyXml(out, seller, fakturs), [], name);
  }
});
