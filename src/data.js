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
  return {
    settings: { ...DEFAULT_PREFS, ...(isObject(raw.settings) ? raw.settings : {}) },
    items,
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
  const { settings, items, history } = data;
  return JSON.stringify({ app: APP, version: 1, settings, items, units, history: history.slice(-MAX_HISTORY) }, null, indent);
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
