import assert from "node:assert/strict";
import { test } from "node:test";
import { addHistory, DEFAULT_PREFS, exportStatus, parseBackup, parseData, serializeData, updateItem } from "../src/data.js";
import { normalizeNitku, normalizeNpwp } from "../src/npwp.js";
import { DEFAULT_UNITS } from "../src/satuan.js";

// Data uji buatan, bukan NPWP asli.
const NPWP = "0" + "4".repeat(15);

test("perangkat baru atau data rusak: mulai dari pengaturan awal", () => {
  for (const text of [null, "", "bukan json", "[]", '{"settings": 5, "items": [], "history": {}}']) {
    const data = parseData(text);
    assert.deepEqual(data.settings, DEFAULT_PREFS);
    assert.deepEqual(data.items, {});
    assert.deepEqual(data.units, DEFAULT_UNITS);
    assert.deepEqual(data.history, []);
  }
  assert.equal(DEFAULT_PREFS.kodeBarang, "720000");
});

test("disimpan lalu dibaca lagi sama; padanan satuan bawaan tidak ikut disimpan", () => {
  const data = parseData(null);
  data.settings.npwpPenjual = NPWP;
  data.units.PACK = "UM.0022";
  data.units.BTG = "UM.0033";
  updateItem(data, "Pipa  Khusus", { coretaxCode: "730000" });
  addHistory(data, [{ number: "J1", file: "a.xml" }]);
  const text = serializeData(data);
  const saved = JSON.parse(text);
  assert.equal(saved.app, "fp-bjy");
  assert.deepEqual(saved.units, { PACK: "UM.0022", BTG: "UM.0033" });
  assert.deepEqual(parseData(text), data);
  assert.deepEqual(parseBackup(serializeData(data, 2)), data);
});

test("cadangan dari aplikasi lain ditolak", () => {
  assert.throws(() => parseBackup('{"settings": {}}'), /Bukan file cadangan FP BJY/);
  assert.throws(() => parseBackup('{"app": "fp-mmm"}'), /Bukan file cadangan FP BJY/);
  assert.throws(() => parseBackup("rusak"), /Bukan file cadangan FP BJY/);
});

test("kode barang: isian kosong kembali ke bawaan", () => {
  const data = parseData(null);
  updateItem(data, "PIPA  khusus", { coretaxCode: "730000" });
  assert.deepEqual(data.items, { "PIPA KHUSUS": { name: "PIPA  khusus", coretaxCode: "730000", unit: "" } });
  updateItem(data, "Pipa Khusus", { unit: "UM.0019" });
  assert.equal(data.items["PIPA KHUSUS"].unit, "UM.0019");
  updateItem(data, "PIPA KHUSUS", { coretaxCode: "", unit: "" });
  assert.deepEqual(data.items, {});
});

test("invoice yang sudah pernah dibuatkan XML dikenali, kecuali daftar yang sama baru saja di-download", () => {
  const history = [
    { number: "J1", file: "01-11 FP BJY.xml", exportedAt: "2026-11-01 09:00", batch: 1 },
    { number: "J2", file: "01-11 FP BJY.xml", exportedAt: "2026-11-01 09:00", batch: 1 },
    { number: "J1", file: "05-11 FP BJY.xml", exportedAt: "2026-11-05 18:25", batch: 2 },
  ];
  // Belum pernah: tidak dicantumkan; pernah: riwayat terakhirnya
  assert.deepEqual(exportStatus(history, ["J3"]), {});
  assert.deepEqual(exportStatus([], ["J1"]), {});
  const status = exportStatus(history, ["J1", "J3"]);
  assert.deepEqual(Object.keys(status), ["J1"]);
  assert.equal(status.J1.state, "previous");
  assert.equal(status.J1.previous.file, "05-11 FP BJY.xml");

  // Daftar yang sama persis dengan XML yang baru di-download (urutan boleh beda): "done"
  const last = { numbers: ["J1", "J2"] };
  assert.deepEqual(Object.values(exportStatus(history, ["J2", "J1"], last)).map((s) => s.state), ["done", "done"]);
  // Daftarnya berubah (ada yang ditambah atau dihapus): yang sudah pernah dibuat harus dipilih lagi
  assert.deepEqual(Object.entries(exportStatus(history, ["J1", "J2", "J3"], last)).map(([n, s]) => [n, s.state]), [["J1", "previous"], ["J2", "previous"]]);
  assert.deepEqual(Object.entries(exportStatus(history, ["J1"], last)).map(([n, s]) => [n, s.state]), [["J1", "previous"]]);
});

test("riwayat dibatasi 1000 baris terakhir", () => {
  const data = parseData(null);
  addHistory(data, Array.from({ length: 1005 }, (_, i) => ({ number: `J${i}` })));
  assert.equal(data.history.length, 1000);
  assert.equal(data.history[0].number, "J5");
});

test("NPWP dan NITKU", () => {
  assert.equal(normalizeNpwp(NPWP), NPWP);
  assert.equal(normalizeNpwp(NPWP.slice(1)), NPWP);
  assert.equal(normalizeNpwp(`${NPWP.slice(0, 2)}.${NPWP.slice(2, 5)}.${NPWP.slice(5)}`), NPWP);
  assert.equal(normalizeNpwp("123"), null);
  assert.equal(normalizeNitku("", NPWP), NPWP + "000000");
  assert.equal(normalizeNitku(NPWP + "000001", NPWP), NPWP + "000001");
  assert.equal(normalizeNitku("12345", NPWP), null);
});
