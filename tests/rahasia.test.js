// Pengaman: tidak boleh ada NPWP/NITKU atau file data di file yang akan di-upload ke repo public.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "contoh", "data", "vendor"]);
const TEXT_FILE = /\.(js|mjs|html|css|json|md|ya?ml|txt|webmanifest|svg)$/i;
const NPWP_LIKE = /(^|\D)\d{15,}(\D|$)|\d{2}\.\d{3}\.\d{3}\.\d-\d{3}\.\d{3}/; // 15/16 digit, NITKU 22 digit, format bertitik

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) yield path;
    else if (!SKIP_DIRS.has(name)) yield* walk(path);
  }
}

test("tidak ada angka mirip NPWP di file kode", () => {
  const found = [];
  for (const path of walk(root)) {
    const rel = relative(root, path);
    if (TEXT_FILE.test(path) && rel !== "package-lock.json" && NPWP_LIKE.test(readFileSync(path, "utf8"))) found.push(rel);
  }
  assert.deepEqual(found, []);
});

test(".gitignore mengecualikan folder dan file data", () => {
  const ignore = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
  for (const rule of ["contoh/", "data/", "*.pdf", "*.xml", "*.csv", "*.xlsx", "*.xls"]) assert.ok(ignore.includes(rule), rule);
});
