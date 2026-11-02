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
import { buildXml } from "../src/xml.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.js", import.meta.url).href;

const app = document.getElementById("app");
const state = {
  data: D.parseData(readStored()),
  invoices: [],
  fakturs: [],
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
  state.fakturs = state.invoices.map((invoice) => {
    const f = computeFaktur(invoice, state.data, settings);
    const done = state.data.history.filter((r) => r.number === invoice.number).at(-1);
    if (done) f.checks.push({ level: "warn", message: `Sudah pernah dibuatkan XML pada ${done.exportedAt} (${done.file})` });
    return f;
  });
}

function render() {
  computeAll();
  const y = scrollY;
  app.replaceChildren(topBar(), state.view === "settings" ? settingsView() : mainView());
  scrollTo(0, y);
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
        : h("button", { class: "secondary", onclick: () => go("settings") }, "Pengaturan"),
    ),
  );
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
      const pages = await extractPages(pdfjs, new Uint8Array(await file.arrayBuffer()), { disableFontFace: true });
      const { invoices, warnings } = parseInvoices(pages);
      if (!invoices.length) toast(`${file.name}: tidak ada invoice yang terbaca`, "error");
      for (const invoice of invoices) {
        if (state.invoices.some((x) => x.number === invoice.number)) {
          toast(`${invoice.number} sudah ada di daftar`);
          continue;
        }
        invoice.warnings.push(...warnings);
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
  const [level, label] = errors ? ["error", "Belum lengkap"] : warnings ? ["warn", "Perlu dicek"] : ["ok", "Siap"];
  const incomplete = f.lines.filter((l) => !isCode(l.code) || !isUnit(l.unit)).length;
  return h(
    "article",
    { class: `invoice ${level}` },
    h(
      "header",
      {},
      h("div", {}, h("strong", {}, f.number), h("small", {}, `${dateText(f.date)} · ${invoice.buyerName}`)),
      h("span", { class: `badge ${level}` }, label),
      h("button", { class: "icon", title: "Hapus dari daftar", "aria-label": `Hapus ${f.number} dari daftar`, onclick: () => removeInvoice(f.number) }, "✕"),
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

/** Total faktur di samping Sub Total, DPP, dan PPN invoice; ✓ kalau sama setelah dibulatkan seperti di faktur Coretax. */
function totalsTable(f) {
  const rows = [["DPP", "taxBaseSen"], ["DPP Nilai Lain", "otherTaxBaseSen"], ["PPN", "vatSen"]];
  return h(
    "table",
    { class: "totals" },
    h("caption", {}, "Invoice: Sub Total, DPP, dan PPN di invoice. ✓ = sama setelah dibulatkan ke rupiah, seperti di faktur Coretax."),
    h("thead", {}, h("tr", {}, h("th", {}), h("th", {}, "Faktur"), h("th", {}, "Invoice"))),
    h(
      "tbody",
      {},
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
  state.invoices = state.invoices.filter((x) => x.number !== number);
  state.editingBuyer.delete(number);
  render();
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

// ---------- ekspor ----------

function exportState() {
  const ready = state.fakturs.filter((f) => f.ready).length;
  const total = state.fakturs.length;
  return { ready, total, canExport: ready === total && sellerOk() };
}

/** Panel di bawah daftar: total, nama file, dan pilihan lain. */
function exportPanel() {
  const { ready, total, canExport } = exportState();
  const sum = (key) => state.fakturs.reduce((a, f) => a + f.totals[key], 0);
  if (!state.filename) state.filename = defaultFilename();
  return h(
    "section",
    { class: "export" },
    h("p", {}, h("strong", {}, `Total ${total} faktur`), ` · DPP ${num(sum("taxBaseSen"))} · PPN ${num(sum("vatSen"))}`),
    field("Nama file", h("input", { value: state.filename, oninput: (e) => (state.filename = e.target.value) })),
    h(
      "div",
      { class: "row" },
      typeof navigator.canShare === "function" && h("button", { class: "secondary", disabled: !canExport, onclick: () => exportXml(true) }, "Bagikan XML…"),
      h("button", { class: "link", onclick: () => { state.invoices = []; state.filename = ""; state.editingBuyer.clear(); render(); } }, "Kosongkan daftar"),
    ),
    !sellerOk() && h("p", { class: "error" }, "Isi dulu NPWP penjual di Pengaturan."),
    ready !== total && h("p", { class: "muted" }, "Lengkapi faktur yang belum siap, atau hapus dari daftar."),
  );
}

/** Baris ringkas yang selalu terlihat di bawah layar. */
function exportBar() {
  const { ready, total, canExport } = exportState();
  return h(
    "div",
    { class: "export-bar" },
    h("span", {}, h("strong", {}, `${ready} dari ${total}`), " faktur siap"),
    h("button", { disabled: !canExport, onclick: () => exportXml(false) }, "Download XML"),
  );
}

async function exportXml(share) {
  const s = state.data.settings;
  const npwp = normalizeNpwp(s.npwpPenjual);
  let xml;
  try {
    xml = buildXml({ tin: npwp, idtku: normalizeNitku(s.nitkuPenjual, npwp) }, state.fakturs);
  } catch (err) {
    return toast(err.message, "error");
  }
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
  const at = stamp();
  D.addHistory(state.data, state.fakturs.map((f) => ({ number: f.number, invoiceDate: f.date, buyer: f.buyerName, exportedAt: at, file: name })));
  save();
  toast(`${name} dibuat (${state.fakturs.length} faktur)`, "ok");
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
  };
  const body = { settings: settingsTab, items: itemsTab, units: unitsTab }[state.tab]();
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
