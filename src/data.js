// Data yang diingat di perangkat ini (localStorage): pengaturan, kode barang dan satuan yang pernah diubah,
// padanan satuan, dan riwayat invoice yang sudah dibuatkan XML. Tidak ada yang dikirim ke mana pun.
import { nameKey } from "./calc.js";
import { DEFAULT_UNITS } from "./satuan.js";

export const LOCAL_KEY = "fp-bjy"; // beda dengan aplikasi FP MMM yang ada di alamat (origin) yang sama
const APP = "fp-bjy";
const MAX_HISTORY = 1000;

export const DEFAULT_PREFS = {
  npwpPenjual: "",
  nitkuPenjual: "",
  namaPenjual: "", // diisi otomatis dari kop invoice pertama; invoice dari penjual lain ditolak
  kodeBarang: "720000",
  kodeTransaksi: "04",
  namaFile: "{DD}-{MM} FP BJY",
};

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** Data dari localStorage atau file cadangan; isi yang rusak atau kosong diganti nilai awal. */
export function parseData(text) {
  let raw = {};
  try {
    raw = JSON.parse(text ?? "{}");
  } catch {
    raw = {};
  }
  if (!isObject(raw)) raw = {};
  const items = {};
  for (const [key, it] of Object.entries(isObject(raw.items) ? raw.items : {})) {
    if (isObject(it)) items[key] = { name: String(it.name ?? key), coretaxCode: String(it.coretaxCode ?? ""), unit: String(it.unit ?? "") };
  }
  const buyers = {};
  for (const [key, b] of Object.entries(isObject(raw.buyers) ? raw.buyers : {})) {
    if (isObject(b) && b.npwp) buyers[key] = { name: String(b.name ?? ""), npwp: String(b.npwp) };
  }
  const meta = isObject(raw.meta) ? raw.meta : {};
  return {
    settings: { ...DEFAULT_PREFS, ...(isObject(raw.settings) ? raw.settings : {}) },
    items,
    buyers, // NPWP yang terakhir dipakai tiap pelanggan, untuk memperingatkan kalau berubah
    meta: { lastBackup: String(meta.lastBackup ?? ""), backupSnooze: String(meta.backupSnooze ?? "") },
    units: { ...DEFAULT_UNITS, ...(isObject(raw.units) ? raw.units : {}) },
    history: Array.isArray(raw.history) ? raw.history.filter(isObject).slice(-MAX_HISTORY) : [],
  };
}

/** Isi file cadangan; ditolak kalau bukan cadangan aplikasi ini. */
export function parseBackup(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  if (!isObject(raw) || raw.app !== APP) throw new Error("Bukan file cadangan FP BJY");
  return parseData(text);
}

/** Padanan satuan bawaan tidak ikut disimpan, supaya perubahan daftar bawaan tetap terpakai. */
export function serializeData(data, indent = 0) {
  const units = Object.fromEntries(Object.entries(data.units).filter(([sat, code]) => DEFAULT_UNITS[sat] !== code));
  const { settings, items, history, buyers = {}, meta = {} } = data;
  return JSON.stringify({ app: APP, version: 1, settings, items, units, buyers, meta, history: history.slice(-MAX_HISTORY) }, null, indent);
}

/** Ubah kode Coretax atau satuan sebuah barang; isian kosong berarti ikut bawaan. */
export function updateItem(data, name, changes) {
  const key = nameKey(name);
  const next = { name, coretaxCode: "", unit: "", ...data.items[key], ...changes };
  if (next.coretaxCode || next.unit) data.items[key] = next;
  else delete data.items[key];
}

export function addHistory(data, entries) {
  data.history = [...data.history, ...entries].slice(-MAX_HISTORY);
}

/**
 * Invoice di daftar yang sudah pernah dibuatkan XML, supaya faktur tidak terbit dua kali di Coretax.
 * - "done": daftar ini sama dengan XML yang baru saja di-download (lastExport); boleh di-download ulang
 *   dengan konfirmasi, karena isinya file yang sama.
 * - "previous": pernah dibuatkan XML sebelumnya; harus dipilih dulu: hapus dari daftar, atau tetap buat lagi.
 * Invoice yang belum pernah dibuatkan XML tidak dicantumkan. `previous` = riwayat terakhir invoice itu.
 */
export function exportStatus(history, numbers, lastExport = null) {
  const sameList = Boolean(lastExport) && numbers.length === lastExport.numbers.length && numbers.every((n) => lastExport.numbers.includes(n));
  const status = {};
  for (const number of numbers) {
    const previous = history.filter((r) => r.number === number).at(-1);
    if (previous) status[number] = { state: sameList ? "done" : "previous", previous };
  }
  return status;
}

/** Kunci pelanggan: kode pelanggan di invoice (mis. G0029), atau namanya kalau tidak berkode. */
export const buyerKey = (invoice) => invoice.buyerCode || nameKey(invoice.buyerName);

/**
 * NPWP yang sebelumnya dipakai untuk pelanggan ini, kalau berbeda dengan `npwp` sekarang; null kalau sama atau
 * pelanggannya belum pernah dibuatkan XML. NPWP yang berubah biasanya salah ketik di invoice.
 */
export function previousNpwp(data, invoice, npwp) {
  const known = data.buyers?.[buyerKey(invoice)];
  return known && npwp && known.npwp !== npwp ? known.npwp : null;
}

/** Ingat NPWP yang dipakai tiap pelanggan saat XML dibuat. entries: [{ invoice, npwp }] */
export function rememberBuyers(data, entries) {
  data.buyers ??= {};
  for (const { invoice, npwp } of entries) {
    const key = buyerKey(invoice);
    if (key && npwp) data.buyers[key] = { name: invoice.buyerName ?? "", npwp };
  }
}

const DAY = 24 * 60 * 60 * 1000;
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Apakah sudah waktunya mengingatkan simpan cadangan: ada isi yang layak dicadangkan, dan sudah 30 hari sejak
 * cadangan terakhir (atau sejak XML pertama kalau belum pernah mencadangkan), kecuali sedang ditunda.
 */
export function backupDue(data, now = new Date()) {
  const { lastBackup = "", backupSnooze = "" } = data.meta ?? {};
  const hasData = data.history.length > 0 || Object.keys(data.items).length > 0;
  const since = lastBackup || String(data.history[0]?.exportedAt ?? "").slice(0, 10);
  if (!hasData || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(since)) return false;
  if (backupSnooze && backupSnooze > isoDate(now)) return false;
  return now - new Date(`${since}T00:00:00`) >= 30 * DAY;
}

export function markBackup(data, now = new Date()) {
  data.meta = { ...data.meta, lastBackup: isoDate(now), backupSnooze: "" };
}

export function snoozeBackup(data, days = 7, now = new Date()) {
  data.meta = { ...data.meta, backupSnooze: isoDate(new Date(now.getTime() + days * DAY)) };
}
