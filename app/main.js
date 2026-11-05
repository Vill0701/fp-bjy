// Tampilan aplikasi: baca PDF invoice, cek & lengkapi, lalu buat XML Coretax.
// Pengaturan, kode barang yang diubah, dan riwayat hanya disimpan di perangkat ini (localStorage).
// Semua teks dari PDF dimasukkan sebagai teks biasa (bukan HTML).
import * as pdfjs from "../vendor/pdfjs/pdf.min.js";
import { computeFaktur, DEFAULT_SETTINGS } from "../src/calc.js";
import * as D from "../src/data.js";
import { normalizeNitku, normalizeNpwp } from "../src/npwp.js";
import { parseInvoices } from "../src/parser.js";
import { extractPages } from "../src/pdf-text.js";
import { normalizeUnit, TRX_CODES, UNIT_NAMES } from "../src/satuan.js";
import { fold, guessQuery, searchCodes, words } from "../src/search.js";
import { buildXml, verifyXml } from "../src/xml.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;

const app = document.getElementById("app");
const state = {
  data: D.parseData(readStored()),
  invoices: [],
  fakturs: [],
  exportInfo: null, // XML yang akan di-download dan hasil pemeriksaannya, dihitung ulang tiap render
  lastExport: null, // XML terakhir yang di-download dari daftar ini: { numbers, xml, at, file }
  view: "main",
  tab: "settings",
  query: "",
  filename: "",
  open: {},
  editingBuyer: new Set(), // nomor invoice yang form pembelinya sedang dibuka
};

// ---------- utilitas ----------

function readStored() {
  try {
    return localStorage.getItem(D.LOCAL_KEY);
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(D.LOCAL_KEY, D.serializeData(state.data));
  } catch (err) {
    toast(`Gagal menyimpan di perangkat ini: ${err.message}`, "error");
  }
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key in el && typeof value !== "string") el[key] = value;
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const pad = (n) => String(n).padStart(2, "0");
const num = (sen) => (sen / 100).toLocaleString("id-ID", { minimumFractionDigits: sen % 100 ? 2 : 0, maximumFractionDigits: 2 });
const qtyText = (qty) => qty.toLocaleString("id-ID", { maximumFractionDigits: 4 });
const dateText = (iso) => (iso ? iso.split("-").reverse().join("-") : "tanggal ?");
const mask = (digits) => (digits ? `•••• ${String(digits).slice(-4)}` : "");
const toRupiah = (sen) => (sen == null ? null : Math.round(sen / 100)); // total faktur di Coretax dibulatkan ke rupiah
const isCode = (code) => /^\d{6}$/.test(code);
const isUnit = (unit) => /^UM\.\d{4}$/.test(unit);

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultFilename() {
  const d = new Date();
  const parts = { DD: pad(d.getDate()), MM: pad(d.getMonth() + 1), YYYY: String(d.getFullYear()) };
  const pattern = state.data.settings.namaFile || D.DEFAULT_PREFS.namaFile;
  return pattern.replace(/\{(DD|MM|YYYY)\}/g, (_, key) => parts[key]);
}

function toast(message, level = "info") {
  for (const old of document.querySelectorAll(".toast")) old.remove();
  const el = h("div", { class: `toast ${level}`, role: "status" }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}

function busy(text) {
  let el = document.getElementById("busy");
  if (!text) return el?.remove();
  if (!el) document.body.append((el = h("div", { id: "busy", role: "status" })));
  el.textContent = text;
}

function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", {}, label), input, hint && h("small", {}, hint));
}

function formError(form, message) {
  const el = form.querySelector(".error");
  el.textContent = message;
  el.hidden = !message;
}

const formData = (form) => Object.fromEntries(new FormData(form));

function download(file) {
  const url = URL.createObjectURL(file);
  const link = h("a", { href: url, download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

function unitSelect({ name, value = "", onChange, invalid = false, emptyLabel = "Pilih satuan…" }) {
  return h(
    "select",
    { name, class: invalid ? "invalid" : "", "aria-label": "Satuan Coretax", onchange: onChange && ((e) => onChange(e.target.value)) },
    h("option", { value: "" }, emptyLabel),
    Object.entries(UNIT_NAMES).map(([code, label]) => h("option", { value: code, selected: code === value }, `${label} (${code})`)),
  );
}

function trxSelect(name, value, emptyLabel) {
  return h(
    "select",
    { name },
    emptyLabel && h("option", { value: "" }, emptyLabel),
    Object.entries(TRX_CODES).map(([code, label]) => h("option", { value: code, selected: code === value }, `${code} - ${label}`)),
  );
}

function details(key, defaultOpen, summary, ...content) {
  return h(
    "details",
    { open: state.open[key] ?? defaultOpen, ontoggle: (e) => (state.open[key] = e.target.open) },
    h("summary", {}, summary),
    ...content,
  );
}

// ---------- mulai ----------

function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  // Data diubah dari tab lain di perangkat yang sama
  addEventListener("storage", (e) => {
    if (e.key !== D.LOCAL_KEY) return;
    state.data = D.parseData(e.newValue);
    render();
  });
  if (!sellerOk()) {
    state.view = "settings";
    state.tab = "settings";
  }
  render();
}

const sellerOk = () => normalizeNpwp(state.data.settings.npwpPenjual) !== null;

function computeSettings() {
  const s = state.data.settings;
  return {
    trxCode: s.kodeTransaksi || DEFAULT_SETTINGS.trxCode,
    goodsCode: isCode(s.kodeBarang) ? s.kodeBarang : DEFAULT_SETTINGS.goodsCode,
    sellerName: s.namaPenjual || "",
  };
}

function computeAll() {
  const settings = computeSettings();
  const exported = D.exportStatus(state.data.history, state.invoices.map((i) => i.number), state.lastExport);
  state.fakturs = state.invoices.map((invoice) => {
    const f = computeFaktur(invoice, state.data, settings);
    const status = exported[invoice.number];
    if (status) {
      // Invoice yang sudah pernah dibuatkan XML tidak boleh ikut XML baru tanpa dipilih dulu: faktur bisa terbit dua kali.
      const where = `${status.previous.exportedAt} (${status.previous.file})`;
      f.exported = { ...status, repeat: Boolean(invoice.repeat) };
      if (status.state === "done") f.checks.push({ level: "ok", message: `Sudah masuk XML ${status.previous.file} (${status.previous.exportedAt})` });
      else if (invoice.repeat) f.checks.push({ level: "info", message: `Dibuat lagi atas pilihanmu. Sebelumnya sudah dibuatkan XML pada ${where}.` });
      else f.checks.push({ level: "error", kind: "duplicate", message: `Sudah pernah dibuatkan XML pada ${where}` });
      f.ready = !f.checks.some((c) => c.level === "error");
    }
    return f;
  });
  state.exportInfo = computeExport();
}

/**
 * Susun XML kalau semua faktur siap, lalu baca ulang isinya dan cocokkan dengan yang tampil di layar
 * (rekap) dan dengan format Coretax. Download hanya bisa kalau tidak ada masalah.
 */
function computeExport() {
  const total = state.fakturs.length;
  const ready = state.fakturs.filter((f) => f.ready).length;
  const info = { total, ready, lineCount: state.fakturs.reduce((a, f) => a + f.lines.length, 0), xml: null, problems: [], canExport: false };
  if (!total || ready !== total || !sellerOk()) return info;
  const s = state.data.settings;
  const tin = normalizeNpwp(s.npwpPenjual);
  const seller = { tin, idtku: normalizeNitku(s.nitkuPenjual, tin) };
  try {
    info.xml = buildXml(seller, state.fakturs);
    info.problems = verifyXml(info.xml, seller, state.fakturs);
    if (!wellFormed(info.xml)) info.problems.push("File XML tidak sah: tidak bisa dibaca sebagai XML");
  } catch (err) {
    info.problems = [err.message];
  }
  info.canExport = info.problems.length === 0;
  return info;
}

/** Dibaca dengan pembaca XML browser, seperti Coretax membaca file impor. */
function wellFormed(xml) {
  try {
    const doc = new DOMParser().parseFromString(xml.replace(/^\uFEFF/, ""), "application/xml");
    return doc.getElementsByTagName("parsererror").length === 0;
  } catch {
    return false;
  }
}

/** [level, label] status faktur seperti di kartu invoice. */
function statusOf(f) {
  const errors = f.checks.filter((c) => c.level === "error");
  if (errors.length) return ["error", errors.every((c) => c.kind === "duplicate") ? "Sudah pernah dibuat" : "Belum lengkap"];
  if (f.checks.some((c) => c.level === "warn")) return ["warn", "Perlu dicek"];
  if (f.exported?.state === "done") return ["ok", "Sudah di-download"];
  return ["ok", "Siap"];
}

/** Faktur yang tertahan karena sudah pernah dibuatkan XML dan belum dipilih: hapus atau buat lagi. */
const heldBack = () => state.fakturs.filter((f) => f.exported?.state === "previous" && !f.exported.repeat);

function render() {
  computeAll();
  const y = scrollY;
  app.replaceChildren(topBar(), state.view === "settings" ? settingsView() : mainView());
  scrollTo(0, y);
  // Di HP deretan tab lebih lebar dari layar: geser supaya tab yang aktif terlihat
  const active = app.querySelector(".tabs .active");
  if (active) {
    const tabs = active.parentElement;
    const hidden = active.getBoundingClientRect().right - tabs.getBoundingClientRect().right;
    if (hidden > 0) tabs.scrollLeft += hidden + 12;
  }
}

function go(view) {
  state.view = view;
  state.query = "";
  render();
  scrollTo(0, 0);
}

function topBar() {
  return h(
    "header",
    { class: "topbar" },
    h("div", { class: "brand" }, h("strong", {}, "FP BJY"), h("span", {}, "Invoice → XML Coretax")),
    h(
      "nav",
      {},
      state.view === "settings"
        ? h("button", { class: "secondary", onclick: () => go("main") }, "← Invoice")
        : [
            h("button", { class: "secondary", onclick: () => openTab("history") }, "Riwayat"),
            h("button", { class: "secondary", onclick: () => openTab(state.tab === "history" ? "settings" : state.tab) }, "Pengaturan"),
          ],
    ),
  );
}

function openTab(tab) {
  state.tab = tab;
  go("settings");
}

// ---------- tampilan utama ----------

function mainView() {
  return h(
    "main",
    {},
    !sellerOk() &&
      h("p", { class: "notice" }, "NPWP penjual belum diisi di perangkat ini. ", h("button", { class: "link", onclick: () => go("settings") }, "Isi di Pengaturan")),
    h(
      "label",
      { class: "upload" },
      h("input", {
        type: "file",
        accept: "application/pdf,.pdf",
        multiple: true,
        onchange: (e) => {
          const files = [...e.target.files];
          e.target.value = "";
          addPdfs(files);
        },
      }),
      h("strong", {}, "Pilih PDF invoice"),
      h("span", {}, "Bisa beberapa file sekaligus. PDF dibaca di perangkat ini saja, tidak di-upload ke mana pun."),
    ),
    state.fakturs.length
      ? state.fakturs.map((f, i) => invoiceCard(state.invoices[i], f))
      : h("p", { class: "empty" }, "Belum ada invoice."),
    state.fakturs.length > 0 && exportPanel(),
    state.fakturs.length > 0 && exportBar(),
    codeDatalist(),
  );
}

async function addPdfs(files) {
  for (const file of files) {
    busy(`Membaca ${file.name}…`);
    try {
      // Isi PDF disimpan (di memori saja) untuk tombol Lihat PDF. PDF.js mengambil alih data yang diberikan
      // kepadanya, jadi yang dibaca adalah salinannya.
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pages = await extractPages(pdfjs, bytes.slice(), { disableFontFace: true });
      const { invoices, warnings } = parseInvoices(pages);
      if (!invoices.length) toast(`${file.name}: tidak ada invoice yang terbaca`, "error");
      for (const invoice of invoices) {
        if (state.invoices.some((x) => x.number === invoice.number)) {
          toast(`${invoice.number} sudah ada di daftar`);
          continue;
        }
        invoice.warnings.push(...warnings);
        invoice.source = { name: file.name, bytes };
        state.invoices.push(invoice);
      }
    } catch (err) {
      toast(`${file.name}: gagal dibaca (${err.message})`, "error");
    }
  }
  busy();
  // Nama penjual diingat dari invoice pertama; invoice dari penjual lain akan ditolak.
  const seller = state.invoices.find((i) => i.seller)?.seller;
  if (!state.data.settings.namaPenjual && seller) {
    state.data.settings.namaPenjual = seller;
    save();
    toast(`Nama penjual dari kop invoice disimpan: ${seller}`, "ok");
  }
  state.invoices.sort((a, b) => a.number.localeCompare(b.number));
  render();
}

function invoiceCard(invoice, f) {
  const errors = f.checks.filter((c) => c.level === "error").length;
  const warnings = f.checks.filter((c) => c.level === "warn").length;
  const [level, label] = statusOf(f);
  const incomplete = f.lines.filter((l) => !isCode(l.code) || !isUnit(l.unit)).length;
  return h(
    "article",
    { class: `invoice ${level}`, id: `inv-${f.number}` },
    h(
      "header",
      {},
      h("div", {}, h("strong", {}, f.number), h("small", {}, `${dateText(f.date)} · ${invoice.buyerName}`)),
      h("span", { class: `badge ${level}` }, label),
      h("button", { class: "icon", title: "Hapus dari daftar", "aria-label": `Hapus ${f.number} dari daftar`, onclick: () => removeInvoice(f.number) }, "✕"),
    ),
    f.exported?.state === "previous" && repeatBox(invoice, f),
    h(
      "div",
      { class: "card-tools" },
      h("button", { type: "button", class: "secondary small", onclick: () => openPdfView(invoice) }, "Lihat PDF"),
      h("small", { class: "muted" }, `${invoice.source?.name ?? ""}${invoice.pages.length > 1 ? ` · hal. ${invoice.pages.join(", ")}` : invoice.pages.length ? ` · hal. ${invoice.pages[0]}` : ""}`),
    ),
    buyerBlock(invoice, f),
    details(`checks:${f.number}`, errors + warnings > 0, `Pemeriksaan (${f.checks.length})`,
      h("ul", { class: "checks" }, f.checks.map((c) => h("li", { class: c.level }, c.message)))),
    f.options.length > 0 && choiceBox(invoice, f),
    details(`lines:${f.number}`, incomplete > 0, `${f.lines.length} baris barang${incomplete ? ` · ${incomplete} belum lengkap` : ""}`,
      f.lines.map((line, i) => lineRow(line, i))),
    totalsTable(f),
  );
}

/**
 * Total faktur di samping Sub Total, DPP, dan PPN invoice; ✓ kalau sama setelah dibulatkan seperti di faktur Coretax.
 * Kalau ada diskon, urutannya seperti di PDF faktur Coretax: Harga Jual, dikurangi Potongan Harga, lalu DPP.
 */
function totalsTable(f) {
  const rows = [["DPP", "taxBaseSen"], ["DPP Nilai Lain", "otherTaxBaseSen"], ["PPN", "vatSen"]];
  const discount = f.totals.discountSen;
  const plain = (label, sen) => h("tr", {}, h("th", { scope: "row" }, label), h("td", {}, num(sen)), h("td", { class: "muted" }, "–"));
  return h(
    "table",
    { class: "totals" },
    h("caption", {}, "Invoice: Sub Total, DPP, dan PPN di invoice. ✓ = sama setelah dibulatkan ke rupiah, seperti di faktur Coretax."),
    h("thead", {}, h("tr", {}, h("th", {}), h("th", {}, "Faktur"), h("th", {}, "Invoice"))),
    h(
      "tbody",
      {},
      discount > 0 && [plain("Harga Jual sebelum potongan", f.totals.taxBaseSen + discount), plain("Potongan Harga", discount)],
      rows.map(([label, key]) => {
        const c = f.compared.find((x) => x.label === label);
        return h(
          "tr",
          {},
          h("th", { scope: "row" }, label),
          h("td", {}, num(f.totals[key])),
          c ? h("td", { class: c.diff ? "diff" : "same" }, `${num(c.want * 100)} ${c.diff ? "≠" : "✓"}`) : h("td", { class: "muted" }, "–"),
        );
      }),
    ),
  );
}

/** Pilihan cara hitung kalau jumlah baris atau total faktur selisih pembulatan dengan invoice. */
function choiceBox(invoice, f) {
  const best = Math.max(...f.options.map((o) => o.matches));
  const title = (o) =>
    o.key === "subtotal"
      ? `${o.label} (selisih ${num(Math.abs(o.adjustSen))} masuk ke baris ${o.adjustLine})`
      : `${o.label} (harga termasuk PPN ÷ 1,11)`;
  const describe = (o) => {
    const off = o.compared.filter((c) => c.diff).map((c) => `${c.label} beda ${num(Math.abs(c.diff) * 100)}`);
    const t = o.totals;
    return `DPP ${num(t.taxBaseSen)} · DPP Nilai Lain ${num(t.otherTaxBaseSen)} · PPN ${num(t.vatSen)}. ` +
      (off.length ? `${off.join(", ")} dari invoice.` : "Sama dengan invoice setelah dibulatkan.");
  };
  return h(
    "fieldset",
    { class: "choice" },
    h("legend", {}, "Pilih cara hitung"),
    f.options.map((o) =>
      h(
        "label",
        { class: o.key === f.choice ? "chosen" : "" },
        h("input", {
          type: "radio",
          name: `cara-${f.number}`,
          value: o.key,
          checked: o.key === f.choice,
          onchange: () => {
            invoice.roundingFix = o.key;
            render();
          },
        }),
        h("span", {}, h("strong", {}, title(o), o.matches === best ? " · paling cocok dengan invoice" : ""), h("small", {}, describe(o))),
      )),
  );
}

function removeInvoice(number) {
  removeInvoices([number]);
}

function removeInvoices(numbers) {
  state.invoices = state.invoices.filter((x) => !numbers.includes(x.number));
  for (const number of numbers) state.editingBuyer.delete(number);
  render();
}

/**
 * Invoice yang sudah pernah dibuatkan XML: harus dipilih dulu, supaya faktur tidak terbit dua kali di Coretax.
 * Setelah dipilih "tetap buat lagi", pilihan itu bisa dibatalkan.
 */
function repeatBox(invoice, f) {
  const { previous, repeat } = f.exported;
  const history = h("button", { type: "button", class: "link", onclick: () => showInHistory(invoice.number) }, "Lihat di Riwayat");
  if (repeat) {
    return h(
      "div",
      { class: "repeat chosen" },
      h("p", {}, `Akan dibuatkan XML lagi atas pilihanmu. Sebelumnya: ${previous.file} (${previous.exportedAt}). `, history),
      h("button", { type: "button", class: "link", onclick: () => { delete invoice.repeat; render(); } }, "Batalkan, jangan buat lagi"),
    );
  }
  return h(
    "div",
    { class: "repeat" },
    h("strong", {}, "Invoice ini sudah pernah dibuatkan XML"),
    h("p", {}, `${previous.file} · ${previous.exportedAt} · `, history),
    h("p", {}, "Kalau XML itu sudah diimpor ke Coretax, membuatnya lagi akan menerbitkan faktur ganda. Buat lagi hanya kalau XML sebelumnya gagal atau belum diimpor."),
    h(
      "div",
      { class: "row" },
      h("button", { type: "button", class: "secondary", onclick: () => removeInvoice(invoice.number) }, "Hapus dari daftar"),
      h("button", { type: "button", class: "danger", onclick: () => { invoice.repeat = true; render(); } }, "Tetap buat lagi"),
    ),
  );
}

/** Buka Riwayat dengan pencarian nomor invoice ini. */
function showInHistory(number) {
  state.tab = "history";
  state.view = "settings";
  state.query = number;
  render();
  scrollTo(0, 0);
}

/** NPWP pembeli diambil dari invoice; bisa diubah untuk invoice ini saja (tidak disimpan). */
function buyerBlock(invoice, f) {
  const edit = (open) => {
    if (open) state.editingBuyer.add(invoice.number);
    else state.editingBuyer.delete(invoice.number);
    render();
  };
  if (f.buyer && !state.editingBuyer.has(invoice.number)) {
    const trx = f.trxCode !== computeSettings().trxCode ? ` · kode transaksi ${f.trxCode}` : "";
    return h(
      "p",
      { class: "buyer" },
      "NPWP pembeli ",
      h("span", { class: "mono" }, mask(f.buyer.npwp)),
      invoice.override ? " (diisi manual)" : "",
      trx,
      " ",
      h("button", { type: "button", class: "link", onclick: () => edit(true) }, "Ubah"),
    );
  }
  const current = invoice.override ?? {};
  const nitku = current.nitku ?? (f.buyer && f.buyer.nitku !== f.buyer.npwp + "000000" ? f.buyer.nitku : "");
  const form = h(
    "form",
    {
      class: `buyer-form${f.buyer ? " edit" : ""}`,
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const npwp = normalizeNpwp(d.npwp);
        if (!npwp || /^0+$/.test(npwp)) return formError(form, "NPWP harus 16 digit angka.");
        const nitkuValue = normalizeNitku(d.nitku, npwp);
        if (!nitkuValue) return formError(form, "NITKU harus 22 digit angka, atau kosongkan untuk kantor pusat.");
        invoice.override = { npwp, nitku: nitkuValue, trxCode: d.trxCode };
        edit(false);
      },
    },
    h("p", {}, f.buyer
      ? ["Data pembeli ", h("strong", {}, invoice.buyerName), " untuk invoice ini saja:"]
      : ["NPWP pembeli ", h("strong", {}, invoice.buyerName), " tidak terbaca dari invoice. Isi manual:"]),
    h(
      "div",
      { class: "row" },
      h("input", { name: "npwp", value: current.npwp ?? f.buyer?.npwp ?? "", placeholder: "NPWP 16 digit", inputmode: "numeric", autocomplete: "off", required: true }),
      h("input", { name: "nitku", value: nitku, placeholder: "NITKU (kosong = pusat)", inputmode: "numeric", autocomplete: "off" }),
    ),
    h("label", {}, h("span", { class: "muted" }, "Kode transaksi"), trxSelect("trxCode", current.trxCode ?? "", "Ikut pengaturan")),
    h("p", { class: "error", hidden: true }),
    h(
      "div",
      { class: "row" },
      h("button", { type: "submit" }, "Simpan"),
      f.buyer && h("button", { type: "button", class: "link", onclick: () => edit(false) }, "Batal"),
      invoice.override && h("button", {
        type: "button",
        class: "link",
        onclick: () => {
          delete invoice.override;
          edit(false);
        },
      }, "Pakai data dari invoice"),
    ),
  );
  return form;
}

function lineRow(line, i) {
  const complete = isCode(line.code) && isUnit(line.unit);
  return h(
    "div",
    { class: `line${complete ? "" : " missing"}` },
    h("div", { class: "line-name" }, h("span", { class: "no" }, i + 1), h("span", {}, line.name)),
    h(
      "div",
      { class: "line-calc" },
      `${qtyText(line.qty)} ${line.invoiceUnit} × ${num(line.priceSen)}`,
      line.unitInclusive != null ? ` (${num(line.unitInclusive * 100)} termasuk PPN)` : "",
      line.discountSen ? ` − diskon ${num(line.discountSen)}` : "",
      ` = DPP ${num(line.taxBaseSen)} · PPN ${num(line.vatSen)}`,
    ),
    h(
      "div",
      { class: "line-inputs" },
      h("input", {
        class: isCode(line.code) ? "" : "invalid",
        value: line.code,
        placeholder: "Kode barang",
        inputmode: "numeric",
        maxlength: "6",
        list: "kode-barang",
        "aria-label": `Kode barang Coretax untuk ${line.name}`,
        onchange: (e) => setItemCode(line, e.target.value),
      }),
      h("button", {
        type: "button",
        class: "secondary",
        "aria-label": `Cari kode barang untuk ${line.name}`,
        onclick: () => openCodeSearch({ itemName: line.name, onPick: (code) => setItemCode(line, code) }),
      }, "Cari"),
      unitSelect({ value: line.unit, invalid: !isUnit(line.unit), onChange: (value) => setLineUnit(line, value) }),
    ),
  );
}

// ---------- pencarian kode barang ----------

let goodsCodes = null;

/** Kode yang pernah dipakai untuk barang yang namanya mengandung semua kata pencarian. */
function learnedCodes(query) {
  const terms = words(query);
  if (!terms.length) return [];
  const byCode = new Map();
  for (const it of Object.values(state.data.items)) {
    if (!isCode(it.coretaxCode) || !terms.every((t) => fold(it.name).includes(t))) continue;
    if (!byCode.has(it.coretaxCode)) byCode.set(it.coretaxCode, []);
    byCode.get(it.coretaxCode).push(it.name);
  }
  return [...byCode].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
}

async function openCodeSearch({ itemName, onPick }) {
  if (!goodsCodes) {
    busy("Memuat daftar kode barang…");
    try {
      goodsCodes = (await import("../src/kode-barang.js")).GOODS_CODES; // dimuat saat pertama kali dibutuhkan
    } catch (err) {
      return toast(`Daftar kode barang gagal dimuat: ${err.message}`, "error");
    } finally {
      busy();
    }
  }
  const names = new Map(goodsCodes.map(([code, indonesian]) => [code, indonesian]));
  const input = h("input", { type: "search", value: guessQuery(itemName), placeholder: "Nama barang atau angka kode, mis. besi", "aria-label": "Cari kode barang" });
  const results = h("div", { class: "results" });
  const onKey = (e) => e.key === "Escape" && close();
  const close = () => {
    dialog.remove();
    removeEventListener("keydown", onKey);
  };
  const option = (code, title, detail) =>
    h("button", { type: "button", class: "result", onclick: () => { close(); onPick(code); } },
      h("span", { class: "mono" }, code),
      h("span", {}, title, detail && h("small", {}, detail)));
  const update = () => {
    const used = learnedCodes(input.value);
    const found = searchCodes(goodsCodes, input.value);
    results.replaceChildren(
      ...(used.length
        ? [h("h4", {}, "Pernah kamu pakai"), ...used.map(([code, items]) =>
            option(code, names.get(code) ?? "", `untuk ${items.slice(0, 2).join(", ")}${items.length > 2 ? ` dan ${items.length - 2} barang lain` : ""}`))]
        : []),
      h("h4", {}, "Daftar kode barang Coretax"),
      ...(found.length
        ? found.map(([code, indonesian, english]) => option(code, indonesian, english))
        : [h("p", { class: "muted" }, input.value.trim() ? "Tidak ada yang cocok. Coba kata lain, atau kata dalam bahasa Inggris." : "Ketik nama barang atau angka kode.")]),
    );
  };
  input.addEventListener("input", update);
  const dialog = h(
    "div",
    { class: "dialog", role: "dialog", "aria-modal": "true", "aria-label": "Cari kode barang", onclick: (e) => e.target === dialog && close() },
    h(
      "div",
      { class: "dialog-box" },
      h("header", {},
        h("div", {}, h("strong", {}, "Cari kode barang"), h("small", {}, itemName)),
        h("button", { type: "button", class: "icon", "aria-label": "Tutup", onclick: close }, "✕")),
      input,
      results,
    ),
  );
  addEventListener("keydown", onKey);
  document.body.append(dialog);
  update();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length); // kursor di akhir kata awal, siap ditambah
}

function setItemCode(line, value) {
  const code = value.replace(/\D/g, "");
  if (code && !isCode(code)) {
    toast("Kode barang Coretax harus 6 angka", "error");
    return render();
  }
  // Kode bawaan tidak perlu diingat per barang; isian kosong juga kembali ke kode bawaan.
  D.updateItem(state.data, line.name, { coretaxCode: code === computeSettings().goodsCode ? "" : code });
  save();
  render();
}

function setLineUnit(line, unit) {
  const sat = normalizeUnit(line.invoiceUnit);
  const mapped = sat ? state.data.units[sat] : undefined;
  if (sat && !mapped && unit) {
    state.data.units[sat] = unit; // satuan baru: berlaku untuk semua barang dengan satuan ini
    toast(`Satuan ${sat} sekarang otomatis ${UNIT_NAMES[unit]} untuk semua barang`);
  } else {
    D.updateItem(state.data, line.name, { unit: unit === mapped ? "" : unit });
  }
  save();
  render();
}

// ---------- lihat PDF invoice ----------

/** "2026-10-30" → "30 Oktober 2026", seperti tertulis di invoice. */
function longDate(iso) {
  if (!iso) return "tidak terbaca";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" });
}

/**
 * Halaman PDF asli di samping yang dibaca aplikasi. Bagian yang dibaca diberi tanda kuning dan baris barang
 * bernomor, jadi baris di PDF yang tidak bertanda kelihatan tidak terbaca.
 */
function openPdfView(invoice) {
  if (!invoice.source) return toast("PDF invoice ini tidak tersedia. Pilih ulang PDF-nya.", "error");
  const pages = h("div", { class: "pdf-pages" }, h("p", { class: "muted" }, "Memuat PDF…"));
  const zoom = h("button", {
    type: "button",
    class: "secondary small",
    "aria-pressed": "false",
    onclick: () => {
      const on = pages.classList.toggle("zoom");
      zoom.textContent = on ? "Perkecil" : "Perbesar";
      zoom.setAttribute("aria-pressed", String(on));
    },
  }, "Perbesar");
  const onKey = (e) => e.key === "Escape" && close();
  const close = () => {
    dialog.remove();
    removeEventListener("keydown", onKey);
  };
  const dialog = h(
    "div",
    { class: "dialog pdf-view", role: "dialog", "aria-modal": "true", "aria-label": `PDF invoice ${invoice.number}`, onclick: (e) => e.target === dialog && close() },
    h(
      "div",
      { class: "dialog-box" },
      h(
        "header",
        {},
        h("div", {}, h("strong", {}, `Invoice ${invoice.number}`), h("small", {}, `${invoice.source.name} · hal. ${invoice.pages.join(", ")}`)),
        zoom,
        h("button", { type: "button", class: "icon", "aria-label": "Tutup", onclick: close }, "✕"),
      ),
      h("div", { class: "pdf-body" }, pages, readPanel(invoice)),
    ),
  );
  addEventListener("keydown", onKey);
  document.body.append(dialog);
  renderPdfPages(invoice, pages).catch((err) => pages.replaceChildren(h("p", { class: "error" }, `PDF gagal ditampilkan: ${err.message}`)));
}

async function renderPdfPages(invoice, box) {
  // Huruf digambar sebagai garis (disableFontFace), karena aturan keamanan aplikasi tidak mengizinkan font dari luar file.
  const task = pdfjs.getDocument({ data: invoice.source.bytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
  try {
    const doc = await task.promise;
    const width = Math.max(320, box.clientWidth);
    const marks = marksOf(invoice);
    const out = [];
    for (const number of invoice.pages) {
      const page = await doc.getPage(number);
      const base = page.getViewport({ scale: 1 });
      // Digambar lebih besar dari lebar layar supaya tetap tajam saat diperbesar 2×
      const viewport = page.getViewport({ scale: (width / base.width) * Math.min(4, 2 * (devicePixelRatio || 1)) });
      const canvas = h("canvas", { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), role: "img", "aria-label": `Halaman ${number}` });
      await page.render({ canvas, viewport }).promise;
      out.push(h("div", { class: "pdf-page" }, canvas, marks.filter((m) => m.page === number).map((m) => markEl(m, base))));
    }
    box.replaceChildren(...out);
  } finally {
    await task.destroy();
  }
}

/** Semua kotak teks yang dibaca: kop, baris barang (bernomor), dan ringkasan. */
function marksOf(invoice) {
  const { header = {}, lines = [], summary = {} } = invoice.marks ?? {};
  return [...Object.values(header), ...lines.map((m, i) => m && { ...m, label: String(i + 1) }), ...Object.values(summary)].filter(Boolean);
}

/** Tanda di atas halaman, dalam persen ukuran halaman supaya ikut membesar saat diperbesar. */
function markEl(m, base) {
  const pad = 1.5; // pt
  const el = h("div", { class: "pdf-mark" }, m.label && h("span", {}, m.label));
  Object.assign(el.style, {
    left: `${((m.x0 - pad) / base.width) * 100}%`,
    top: `${((m.top - pad / 2) / base.height) * 100}%`,
    width: `${((m.x1 - m.x0 + 2 * pad) / base.width) * 100}%`,
    height: `${((m.bottom - m.top + pad) / base.height) * 100}%`,
  });
  return el;
}

/** Angka dan teks persis seperti yang dibaca dari PDF, disusun seperti invoice supaya mudah dibandingkan. */
function readPanel(invoice) {
  const s = invoice.summary ?? {};
  const n = (v) => (v == null ? "tidak terbaca" : v.toLocaleString("id-ID", { maximumFractionDigits: 4 }));
  const summaryRows = [["SUB TOTAL", "subTotal"], ["DISCOUNT", "discount"], ["DPP", "dpp"], ["PPN", "ppn"], ["TOTAL", "total"]];
  return h(
    "section",
    { class: "pdf-read" },
    h("h3", {}, "Yang dibaca aplikasi"),
    h("p", { class: "muted" }, "Bagian PDF yang dibaca diberi tanda kuning; nomor baris barang sama dengan tabel di bawah. Kalau ada baris di PDF yang tidak bertanda, baris itu tidak terbaca."),
    h(
      "dl",
      { class: "read-head" },
      h("dt", {}, "Penjualan"), h("dd", {}, invoice.number),
      h("dt", {}, "Tanggal"), h("dd", {}, longDate(invoice.date)),
      h("dt", {}, "Customer"), h("dd", {}, [invoice.buyerCode, invoice.buyerName].filter(Boolean).join("-") || "tidak terbaca"),
      h("dt", {}, "NPWP"),
      h("dd", {}, h("span", { class: "mono" }, invoice.buyerNpwp || "tidak ada"), invoice.override ? h("small", {}, ` · di faktur diganti manual (${mask(invoice.override.npwp)})`) : null),
    ),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        { class: "read-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "No"), h("th", {}, "Nama Barang"), ["Qty", "Harga", "Disc", "Jumlah"].map((t) => h("th", { class: "num" }, t)))),
        h(
          "tbody",
          {},
          invoice.lines.map((l) =>
            h(
              "tr",
              {},
              h("td", {}, h("span", { class: "line-no" }, l.no)),
              h("td", {}, l.name),
              h("td", { class: "num" }, `${n(l.qty)} ${l.unit}`),
              h("td", { class: "num" }, n(l.price)),
              h("td", { class: "num" }, l.disc || "–"),
              h("td", { class: "num" }, n(l.total)),
            )),
        ),
      ),
    ),
    h(
      "table",
      { class: "read-table read-summary" },
      h("tbody", {}, summaryRows.map(([label, key]) => h("tr", {}, h("th", { scope: "row" }, label), h("td", { class: "num" }, key === "discount" && !s[key] ? "-" : n(s[key]))))),
    ),
  );
}

// ---------- rekap ----------

// Kolom angka seperti di daftar faktur keluaran Coretax; label ketiga = nama pembanding dengan invoice (f.compared).
const RECAP_AMOUNTS = [
  ["taxBaseSen", "Harga Jual", "DPP"],
  ["otherTaxBaseSen", "DPP Nilai Lain", "DPP Nilai Lain"],
  ["vatSen", "PPN", "PPN"],
];

/** Baris rekap dari faktur yang sedang dibuat. */
function recapRow(f) {
  const { discountSen, taxBaseSen, otherTaxBaseSen, vatSen } = f.totals;
  const [level, label] = statusOf(f);
  return { number: f.number, date: f.date, buyerName: f.buyerName, discountSen, taxBaseSen, otherTaxBaseSen, vatSen, compared: f.compared, level, label };
}

/** Baris rekap dari riwayat; XML yang dibuat sebelum ada rekap tidak punya angka. */
const historyRow = (r) => ({
  number: r.number,
  date: r.invoiceDate,
  buyerName: r.buyer,
  discountSen: r.discountSen,
  taxBaseSen: r.taxBaseSen,
  otherTaxBaseSen: r.otherTaxBaseSen,
  vatSen: r.vatSen,
});

/** Jumlah per kolom dari angka yang sudah dibulatkan per faktur, seperti total daftar faktur di Coretax. */
function recapTotal(rows, key) {
  return rows.every((r) => r[key] != null) ? rows.reduce((a, r) => a + toRupiah(r[key]), 0) : null;
}

function recapTable(rows, { onPick } = {}) {
  const amountCell = (row, [key, label, compareLabel]) => {
    const value = toRupiah(row[key]);
    if (value == null) return h("td", { class: "num muted", "data-label": label }, "–");
    const c = row.compared?.find((x) => x.label === compareLabel);
    return h(
      "td",
      { class: `num${c?.diff ? " diff" : ""}`, "data-label": label },
      num(value * 100),
      c && h("span", { class: c.diff ? "mark diff" : "mark same", title: c.diff ? "Beda dengan invoice" : "Sama dengan invoice" }, c.diff ? " ≠" : " ✓"),
      c?.diff ? h("small", {}, `invoice ${num(c.want * 100)}`) : null,
      key === "taxBaseSen" && row.discountSen ? h("small", {}, `setelah potongan ${num(row.discountSen)}`) : null,
    );
  };
  return h(
    "div",
    { class: "table-scroll" },
    h(
      "table",
      { class: "recap" },
      h("thead", {}, h("tr", {}, h("th", { class: "no" }, "No"), h("th", {}, "Referensi"), h("th", {}, "Nama Pembeli"), RECAP_AMOUNTS.map(([, label]) => h("th", { class: "num" }, label)))),
      h(
        "tbody",
        {},
        rows.map((r, i) =>
          h(
            "tr",
            {},
            h("td", { class: "no" }, i + 1),
            h(
              "td",
              { class: "ref" },
              onPick ? h("button", { type: "button", class: "link", onclick: () => onPick(r.number) }, r.number) : h("strong", {}, r.number),
              h("small", {}, dateText(r.date)),
              r.level && r.level !== "ok" ? h("small", { class: `status ${r.level}` }, r.label) : null,
            ),
            h("td", { class: "name" }, r.buyerName || "–"),
            RECAP_AMOUNTS.map((col) => amountCell(r, col)),
          )),
      ),
      h(
        "tfoot",
        {},
        h(
          "tr",
          {},
          h("td", { class: "no" }),
          h("th", { scope: "row", colspan: 2 }, `Total ${rows.length} faktur`),
          RECAP_AMOUNTS.map(([key, label]) => {
            const total = recapTotal(rows, key);
            return h("td", { class: "num", "data-label": label }, total == null ? "–" : num(total * 100));
          }),
        ),
      ),
    ),
  );
}

/** Salin rekap sebagai tabel (dipisah tab) untuk ditempel di Excel atau chat. Angka tanpa titik supaya terbaca Excel. */
async function copyRecap(rows) {
  const amount = (sen) => (sen == null ? "" : String(toRupiah(sen)));
  const total = (key) => String(recapTotal(rows, key) ?? "");
  const withDiscount = rows.some((r) => r.discountSen);
  const table = [
    ["No", "Referensi", "Tanggal", "Nama Pembeli", "Harga Jual", ...(withDiscount ? ["Potongan Harga"] : []), "DPP Nilai Lain", "PPN"],
    ...rows.map((r, i) => [i + 1, r.number, dateText(r.date), r.buyerName, amount(r.taxBaseSen), ...(withDiscount ? [amount(r.discountSen ?? 0)] : []), amount(r.otherTaxBaseSen), amount(r.vatSen)]),
    ["", "Total", "", `${rows.length} faktur`, total("taxBaseSen"), ...(withDiscount ? [total("discountSen")] : []), total("otherTaxBaseSen"), total("vatSen")],
  ];
  // Sel yang diawali = + - @ dijalankan Excel sebagai rumus saat ditempel; diberi tanda kutip supaya tetap teks
  const cell = (c) => {
    const s = String(c ?? "").replace(/\s+/g, " ").trim();
    return /^[=+\-@]/.test(s) && !/^-?\d+$/.test(s) ? `'${s}` : s;
  };
  const text = table.map((cols) => cols.map(cell).join("\t")).join("\r\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Rekap disalin. Tempel di Excel atau chat.", "ok");
  } catch {
    toast("Rekap gagal disalin di perangkat ini.", "error");
  }
}

function scrollToInvoice(number) {
  document.getElementById(`inv-${number}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- ekspor ----------

/** Panel di bawah daftar: rekap isi XML, hasil pemeriksaan, nama file, dan pilihan lain. */
function exportPanel() {
  const { canExport } = state.exportInfo;
  const rows = state.fakturs.map(recapRow);
  if (!state.filename) state.filename = defaultFilename();
  return h(
    "section",
    { class: "export", id: "rekap" },
    h(
      "div",
      { class: "export-head" },
      h("h2", {}, "Rekap XML"),
      h("button", { type: "button", class: "secondary", onclick: () => copyRecap(rows) }, "Salin rekap"),
    ),
    h("p", { class: "muted" }, `Isi file XML yang akan dibuat. Setelah impor, cocokkan dengan daftar faktur keluaran di Coretax lewat nomor Referensi.`),
    recapTable(rows, { onPick: scrollToInvoice }),
    h(
      "ul",
      { class: "notes" },
      h("li", {}, "Angka dibulatkan ke rupiah, seperti di daftar faktur Coretax. Harga Jual = DPP, yaitu setelah potongan harga."),
      h("li", {}, "✓ = sama dengan invoice. Klik nomor referensi untuk melihat invoicenya."),
      h("li", {}, "Nama pembeli di Coretax diisi otomatis dari NPWP. Kalau namanya beda dengan rekap ini, NPWP di invoice mungkin salah."),
    ),
    exportStatusBlock(),
    field("Nama file", h("input", { value: state.filename, oninput: (e) => (state.filename = e.target.value) })),
    h(
      "div",
      { class: "row" },
      typeof navigator.canShare === "function" && h("button", { class: "secondary", disabled: !canExport, onclick: () => exportXml(true) }, "Bagikan XML…"),
      h("button", { class: "link", onclick: clearList }, "Kosongkan daftar"),
    ),
  );
}

function clearList() {
  state.invoices = [];
  state.filename = "";
  state.lastExport = null; // daftar baru: invoice yang sudah di-download tadi harus dipilih lagi kalau dimasukkan ulang
  state.editingBuyer.clear();
  render();
}

/** Apa yang menahan download, atau hasil pemeriksaan XML kalau sudah bisa di-download. */
function exportStatusBlock() {
  const { ready, total, lineCount, problems, canExport } = state.exportInfo;
  if (!sellerOk()) return h("p", { class: "error" }, "Isi dulu NPWP penjual di Pengaturan.");
  const held = heldBack();
  const others = total - ready - held.length;
  if (held.length || others > 0) {
    return [
      held.length > 0 &&
        h(
          "div",
          { class: "repeat" },
          h("strong", {}, `${held.length} invoice sudah pernah dibuatkan XML: ${held.map((f) => f.number).join(", ")}`),
          h("p", {}, "Supaya faktur tidak terbit dua kali di Coretax, hapus dari daftar. Buat lagi hanya kalau XML sebelumnya gagal atau belum diimpor."),
          held.length > 1 &&
            h(
              "div",
              { class: "row" },
              h("button", { type: "button", class: "secondary", onclick: () => removeInvoices(held.map((f) => f.number)) }, `Hapus ${held.length} invoice ini`),
              h("button", { type: "button", class: "danger", onclick: () => repeatAll(held) }, "Tetap buat lagi semuanya"),
            ),
        ),
      others > 0 && h("p", { class: "muted" }, "Lengkapi faktur yang belum siap, atau hapus dari daftar."),
    ];
  }
  if (!canExport) {
    return h(
      "div",
      { class: "xml-check error" },
      h("strong", {}, "XML tidak bisa dibuat karena isinya tidak sesuai:"),
      h("ul", {}, problems.map((p) => h("li", {}, p))),
      h("small", {}, "Ini seharusnya tidak terjadi. Kirim tangkapan layar ini ke pembuat aplikasi."),
    );
  }
  return [
    h("p", { class: "xml-check ok" }, `XML sudah dibaca ulang dan dicek: ${total} faktur dan ${lineCount} baris barang di file sama persis dengan rekap ini. NPWP, NITKU, kode barang, satuan, dan rumus DPP Nilai Lain serta PPN di setiap baris sesuai format Coretax.`),
    allDone() &&
      h("p", { class: "notice" }, `Daftar ini sudah di-download pada ${state.lastExport.at} (${state.lastExport.file}). Download lagi hanya kalau file itu hilang, dan jangan impor dua kali ke Coretax.`),
  ];
}

/** Semua invoice di daftar sudah masuk XML yang baru saja di-download. */
const allDone = () => state.fakturs.length > 0 && state.fakturs.every((f) => f.exported?.state === "done");

function repeatAll(fakturs) {
  if (!confirm(`Buat XML lagi untuk ${fakturs.length} invoice yang sudah pernah dibuatkan XML? Pastikan XML sebelumnya belum diimpor ke Coretax, supaya faktur tidak terbit dua kali.`)) return;
  for (const f of fakturs) {
    const invoice = state.invoices.find((x) => x.number === f.number);
    if (invoice) invoice.repeat = true;
  }
  render();
}

/** Baris ringkas yang selalu terlihat di bawah layar. */
function exportBar() {
  const { ready, total, canExport } = state.exportInfo;
  return h(
    "div",
    { class: "export-bar" },
    h("span", {}, h("strong", {}, `${ready} dari ${total}`), " faktur siap"),
    h("button", { type: "button", class: "link", onclick: () => document.getElementById("rekap")?.scrollIntoView({ behavior: "smooth" }) }, "Rekap"),
    h("button", { disabled: !canExport, onclick: () => exportXml(false) }, allDone() ? "Download lagi" : "Download XML"),
  );
}

async function exportXml(share) {
  // Dihitung ulang tepat sebelum download, supaya yang di-download pasti yang baru saja diperiksa.
  const { xml, problems, canExport } = computeExport();
  if (!canExport) {
    render();
    return toast(problems[0] ?? "XML belum bisa dibuat", "error");
  }
  const again = allDone();
  if (again && !confirm(`Daftar ini sudah di-download pada ${state.lastExport.at} (${state.lastExport.file}). Download lagi?\n\nJangan impor dua kali ke Coretax: faktur akan terbit ganda.`)) return;
  const name = (state.filename.trim() || defaultFilename()).replace(/\.xml$/i, "") + ".xml";
  const file = new File([xml], name, { type: "application/xml" });
  if (share) {
    if (!navigator.canShare({ files: [file] })) return toast("Perangkat ini tidak bisa membagikan file, pakai Download.", "error");
    try {
      await navigator.share({ files: [file], title: name });
    } catch (err) {
      if (err.name !== "AbortError") toast(`Gagal membagikan: ${err.message}`, "error");
      return;
    }
  } else {
    download(file);
  }
  // File yang sama persis di-download ulang tidak dicatat lagi di riwayat.
  if (again && xml === state.lastExport.xml) {
    toast(`${name} di-download lagi (isi sama dengan sebelumnya). Jangan impor dua kali ke Coretax.`, "ok");
    return render();
  }
  const at = stamp();
  const batch = Date.now(); // satu kelompok riwayat per file XML
  D.addHistory(
    state.data,
    state.fakturs.map((f) => {
      const { discountSen, taxBaseSen, otherTaxBaseSen, vatSen } = f.totals;
      return { number: f.number, invoiceDate: f.date, buyer: f.buyerName, exportedAt: at, file: name, batch, discountSen, taxBaseSen, otherTaxBaseSen, vatSen };
    }),
  );
  save();
  state.lastExport = { numbers: state.invoices.map((i) => i.number), xml, at, file: name };
  toast(`${name} dibuat (${state.fakturs.length} faktur), isinya sudah dicek ulang. Rekapnya tersimpan di Riwayat.`, "ok");
  render();
}

function codeDatalist() {
  const codes = new Map([[computeSettings().goodsCode, "kode bawaan"]]);
  for (const it of Object.values(state.data.items)) if (isCode(it.coretaxCode) && !codes.has(it.coretaxCode)) codes.set(it.coretaxCode, `contoh: ${it.name}`);
  return h("datalist", { id: "kode-barang" }, [...codes].sort().map(([code, label]) => h("option", { value: code }, label)));
}

// ---------- pengaturan ----------

let listBuilder = () => [];

function listSection(builder) {
  listBuilder = builder;
  return h("div", { id: "settings-list" }, builder());
}

function searchBox(placeholder) {
  return h("input", {
    type: "search",
    class: "search",
    placeholder,
    value: state.query,
    oninput: (e) => {
      state.query = e.target.value;
      document.getElementById("settings-list")?.replaceChildren(...listBuilder());
    },
  });
}

function settingsView() {
  const tabs = {
    settings: "Pengaturan",
    items: `Barang (${Object.keys(state.data.items).length})`,
    units: "Satuan",
    history: `Riwayat (${historyFiles().length})`,
  };
  const body = { settings: settingsTab, items: itemsTab, units: unitsTab, history: historyTab }[state.tab]();
  return h(
    "main",
    { class: "master" },
    h("nav", { class: "tabs" }, Object.entries(tabs).map(([key, label]) =>
      h("button", { class: state.tab === key ? "active" : "", onclick: () => { state.tab = key; state.query = ""; render(); } }, label))),
    body,
    codeDatalist(),
  );
}

function settingsTab() {
  const s = state.data.settings;
  const codeInput = h("input", { name: "kodeBarang", value: s.kodeBarang, inputmode: "numeric", maxlength: "6", list: "kode-barang", required: true });
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const npwp = normalizeNpwp(d.npwpPenjual);
        if (!npwp) return formError(form, "NPWP penjual harus 16 digit angka.");
        const nitku = normalizeNitku(d.nitkuPenjual, npwp);
        if (!nitku) return formError(form, "NITKU penjual harus 22 digit angka, atau kosongkan.");
        const kodeBarang = d.kodeBarang.replace(/\D/g, "");
        if (!isCode(kodeBarang)) return formError(form, "Kode barang bawaan harus 6 angka.");
        const first = !sellerOk();
        Object.assign(s, {
          npwpPenjual: npwp,
          nitkuPenjual: nitku,
          namaPenjual: d.namaPenjual.trim(),
          kodeBarang,
          kodeTransaksi: d.kodeTransaksi,
          namaFile: d.namaFile.trim() || D.DEFAULT_PREFS.namaFile,
        });
        save();
        navigator.storage?.persist?.().catch(() => {}); // minta browser tidak menghapus data perangkat ini
        state.filename = "";
        toast("Pengaturan disimpan", "ok");
        if (first) go("main");
        else render();
      },
    },
    !sellerOk() && h("p", { class: "notice" }, "Isi NPWP penjual sekali di perangkat ini, lalu aplikasi siap dipakai."),
    h("h3", {}, "Penjual"),
    field("NPWP penjual (16 digit)", h("input", { name: "npwpPenjual", value: s.npwpPenjual, inputmode: "numeric", autocomplete: "off", required: true })),
    field("NITKU penjual", h("input", { name: "nitkuPenjual", value: s.nitkuPenjual, inputmode: "numeric", autocomplete: "off" }), "Kosongkan untuk kantor pusat (NPWP + 000000)."),
    field(
      "Nama penjual di kop invoice",
      h("input", { name: "namaPenjual", value: s.namaPenjual, autocomplete: "off" }),
      "Terisi otomatis dari invoice pertama. Invoice dengan nama penjual lain akan ditolak; kosongkan kalau tidak perlu dicek.",
    ),
    h("h3", {}, "Faktur"),
    field(
      "Kode barang bawaan",
      h("div", { class: "code-field" },
        codeInput,
        h("button", { type: "button", class: "secondary", onclick: () => openCodeSearch({ itemName: "besi", onPick: (code) => (codeInput.value = code) }) }, "Cari")),
      "Dipakai untuk semua barang, kecuali yang kodenya diubah (lihat tab Barang).",
    ),
    field("Kode transaksi", trxSelect("kodeTransaksi", s.kodeTransaksi)),
    field("Nama file XML", h("input", { name: "namaFile", value: s.namaFile }), "{DD} = tanggal, {MM} = bulan, {YYYY} = tahun saat file dibuat."),
    h("p", { class: "error", hidden: true }),
    h("button", { type: "submit" }, "Simpan pengaturan"),
  );
  return [form, deviceBox()];
}

function deviceBox() {
  const restoreInput = h("input", {
    type: "file",
    accept: ".json,application/json",
    hidden: true,
    onchange: async (e) => {
      const [file] = e.target.files;
      e.target.value = "";
      if (!file) return;
      let restored;
      try {
        restored = D.parseBackup(await file.text());
      } catch (err) {
        return toast(`${file.name}: ${err.message}`, "error");
      }
      if (!confirm("Ganti pengaturan, kode barang, dan riwayat di perangkat ini dengan isi cadangan?")) return;
      state.data = restored;
      save();
      toast("Cadangan dipulihkan", "ok");
      render();
    },
  });
  return h(
    "section",
    { class: "card" },
    h("h3", {}, "Data di perangkat ini"),
    h(
      "p",
      { class: "muted" },
      "Pengaturan, kode barang yang diubah, dan riwayat XML hanya tersimpan di browser ini, tidak dikirim ke mana pun. ",
      "Untuk memindahkannya ke perangkat lain, simpan cadangan lalu pulihkan di sana. ",
      "Di iPhone/iPad, pasang aplikasi ke Layar Utama supaya datanya tidak dihapus Safari.",
    ),
    h(
      "div",
      { class: "row" },
      h("button", {
        type: "button",
        class: "secondary",
        onclick: () => download(new File([D.serializeData(state.data, 2)], `cadangan FP BJY ${stamp().slice(0, 10)}.json`, { type: "application/json" })),
      }, "Simpan cadangan"),
      h("button", { type: "button", class: "secondary", onclick: () => restoreInput.click() }, "Pulihkan cadangan"),
      restoreInput,
    ),
    h("h3", {}, "Hapus"),
    h("button", {
      type: "button",
      class: "danger",
      onclick: () => {
        if (!confirm("Hapus semua pengaturan, kode barang, dan riwayat dari perangkat ini?")) return;
        try {
          localStorage.removeItem(D.LOCAL_KEY);
        } catch {
          // tetap kosongkan data di layar
        }
        state.data = D.parseData(null);
        toast("Data di perangkat ini dihapus", "ok");
        render();
      },
    }, "Hapus data di perangkat ini"),
  );
}

function itemsTab() {
  const goodsCode = computeSettings().goodsCode;
  return [
    h("p", { class: "muted" }, `Barang yang kode atau satuannya pernah kamu ubah. Barang lain otomatis memakai kode ${goodsCode} dan satuan sesuai tab Satuan.`),
    searchBox("Cari nama barang atau kode"),
    listSection(() => {
      const q = state.query.trim().toUpperCase();
      const list = Object.entries(state.data.items)
        .filter(([key, it]) => !q || key.includes(q) || it.coretaxCode.includes(q))
        .sort(([a], [b]) => a.localeCompare(b));
      if (!list.length) return [h("p", { class: "empty" }, q ? "Tidak ada yang cocok." : "Belum ada barang yang diubah.")];
      return [...list.slice(0, 200).map(([key, it]) => itemRow(key, it)), list.length > 200 && h("p", { class: "muted" }, "Ketik untuk mencari barang lainnya.")];
    }),
  ];
}

function itemRow(key, it) {
  const codeInput = h("input", { name: "coretaxCode", value: it.coretaxCode, inputmode: "numeric", maxlength: "6", list: "kode-barang", placeholder: computeSettings().goodsCode });
  const form = h(
    "form",
    {
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const coretaxCode = d.coretaxCode.replace(/\D/g, "");
        if (coretaxCode && !isCode(coretaxCode)) return formError(form, "Kode barang Coretax harus 6 angka.");
        D.updateItem(state.data, it.name, { coretaxCode: coretaxCode === computeSettings().goodsCode ? "" : coretaxCode, unit: d.unit });
        save();
        render();
      },
    },
    field(
      "Kode barang Coretax",
      h("div", { class: "code-field" },
        codeInput,
        h("button", {
          type: "button",
          class: "secondary",
          onclick: () => openCodeSearch({ itemName: it.name, onPick: (picked) => (codeInput.value = picked) }),
        }, "Cari")),
      "Kosongkan untuk memakai kode bawaan.",
    ),
    field("Satuan Coretax", unitSelect({ name: "unit", value: it.unit, emptyLabel: "Ikut padanan satuan invoice" })),
    h("p", { class: "error", hidden: true }),
    h(
      "div",
      { class: "row" },
      h("button", { type: "submit" }, "Simpan"),
      h("button", {
        type: "button",
        class: "danger",
        onclick: () => {
          if (!confirm(`Kembalikan ${it.name} ke kode dan satuan bawaan?`)) return;
          delete state.data.items[key];
          save();
          render();
        },
      }, "Kembalikan ke bawaan"),
    ),
  );
  return h(
    "details",
    { class: "row-item" },
    h("summary", {}, h("span", {}, it.name), h("span", { class: "mono muted" }, it.coretaxCode || "bawaan")),
    form,
  );
}

/** Riwayat dikelompokkan per file XML, yang terbaru di atas. */
function historyFiles() {
  const files = new Map();
  for (const r of state.data.history) {
    const key = r.batch ? `batch:${r.batch}` : `${r.exportedAt ?? ""}|${r.file ?? ""}`; // riwayat lama belum punya batch
    if (!files.has(key)) files.set(key, { key, exportedAt: r.exportedAt ?? "", file: r.file ?? "", rows: [] });
    files.get(key).rows.push(r);
  }
  return [...files.values()].reverse();
}

function historyTab() {
  const files = historyFiles();
  return [
    h("p", { class: "muted" }, "XML yang pernah dibuat di perangkat ini, yang terbaru di atas. Rekapnya bisa dicocokkan dengan daftar faktur keluaran di Coretax."),
    searchBox("Cari nomor invoice atau nama pembeli"),
    listSection(() => {
      const q = state.query.trim().toUpperCase();
      const matches = (r) => String(r.number ?? "").toUpperCase().includes(q) || String(r.buyer ?? "").toUpperCase().includes(q);
      const shown = files.filter((g) => !q || g.rows.some(matches));
      if (!shown.length) return [h("p", { class: "empty" }, q ? "Tidak ada yang cocok." : "Belum ada XML yang dibuat di perangkat ini.")];
      return [
        ...shown.slice(0, 100).map((g, i) => {
          const rows = g.rows.map(historyRow);
          const vat = recapTotal(rows, "vatSen");
          return h(
            "details",
            { class: "row-item history", open: state.open[`riwayat:${g.key}`] ?? (i === 0 || Boolean(q)), ontoggle: (e) => (state.open[`riwayat:${g.key}`] = e.target.open) },
            h("summary", {}, h("span", {}, h("strong", {}, g.file || "(tanpa nama)"), h("small", {}, g.exportedAt)), h("span", { class: "muted" }, `${rows.length} faktur${vat == null ? "" : ` · PPN ${num(vat * 100)}`}`)),
            recapTable(rows),
            rows.some((r) => r.vatSen == null) && h("p", { class: "muted" }, "Angka rekap hanya tersimpan untuk XML yang dibuat sejak fitur rekap ada."),
            h("div", { class: "row" }, h("button", { type: "button", class: "secondary", onclick: () => copyRecap(rows) }, "Salin rekap")),
          );
        }),
        shown.length > 100 && h("p", { class: "muted" }, "Ketik untuk mencari XML lainnya."),
      ];
    }),
  ];
}

function unitsTab() {
  const units = state.data.units;
  const form = h(
    "form",
    {
      class: "row",
      onsubmit: (e) => {
        e.preventDefault();
        const d = formData(form);
        const sat = normalizeUnit(d.sat);
        if (!sat || !d.unit) return;
        units[sat] = d.unit;
        save();
        render();
      },
    },
    h("input", { name: "sat", placeholder: "Satuan di invoice, mis. KG", required: true, autocapitalize: "characters" }),
    unitSelect({ name: "unit" }),
    h("button", { type: "submit" }, "Tambah"),
  );
  return [
    h("p", { class: "muted" }, "Satuan di invoice otomatis diubah menjadi satuan Coretax sesuai daftar ini."),
    Object.entries(units)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([sat, unit]) => h("div", { class: "unit-row" }, h("span", { class: "mono" }, sat),
        unitSelect({ value: unit, onChange: (value) => { if (value) { units[sat] = value; save(); render(); } } }))),
    h("h3", {}, "Tambah padanan satuan"),
    form,
  ];
}

start();
