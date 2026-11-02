import assert from "node:assert/strict";
import { test } from "node:test";
import { GOODS_CODES } from "../src/kode-barang.js";
import { guessQuery, searchCodes } from "../src/search.js";

const codes = (query, limit) => searchCodes(GOODS_CODES, query, limit).map(([code]) => code);

test("daftar kode barang Coretax lengkap dan rapi", () => {
  assert.equal(GOODS_CODES.length, 1348);
  assert.equal(new Set(GOODS_CODES.map(([code]) => code)).size, GOODS_CODES.length);
  assert.ok(GOODS_CODES.every(([code, id, en]) => /^\d{6}$/.test(code) && id && en));
  assert.ok(!GOODS_CODES.some((row) => /[âï][\u0080-™]/.test(row.join(""))), "masih ada karakter rusak");
  const pearls = GOODS_CODES.find(([code]) => code === "710000");
  assert.match(pearls[1], /perhiasan imitasi; koin$/); // data yang terpotong ke baris berikutnya di file asli
});

test("cari kode barang dengan kata atau angka", () => {
  assert.equal(codes("baut")[0], "731800");
  assert.equal(codes("7318")[0], "731800");
  assert.equal(codes("gerinda")[0], "680400");
  assert.ok(codes("kabel listrik").includes("854400"));
  assert.ok(codes("cat pernis", 5).includes("320800"));
  assert.ok(codes("sarung tangan", 5).includes("611600"));
  assert.ok(codes("thinner").includes("381400")); // lewat nama Inggris
  assert.equal(codes("lem")[0], "350600"); // kata utuh "lem", bukan "lembu"
  assert.deepEqual(codes(""), []);
  assert.deepEqual(codes("qqzzxx"), []);
});

test("tebakan kata pencarian dari nama barang", () => {
  assert.equal(guessQuery("KABEL SUPREME NYYHY 3X4MM"), "kabel");
  assert.equal(guessQuery('WD CUTTING WELL 14"'), "cutting");
  assert.equal(guessQuery("12 X 34"), "");
});
