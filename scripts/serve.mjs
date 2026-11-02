// Server lokal untuk mencoba aplikasi di laptop: npm start → http://localhost:8080
// Hanya file aplikasi yang dilayani; folder contoh/ tidak pernah ikut.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = /^\/(index\.html|sw\.js|manifest\.webmanifest|icon\.svg|(app|src|vendor)\/[\w.-]+(\/[\w.-]+)*)$/;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
const port = Number(process.env.PORT) || 8080;

createServer(async (req, res) => {
  let path = new URL(req.url, "http://localhost").pathname;
  if (path === "/") path = "/index.html";
  if (!ALLOWED.test(path) || path.includes("..")) return res.writeHead(404).end("Tidak ditemukan");
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-cache" }).end(body);
  } catch {
    res.writeHead(404).end("Tidak ditemukan");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Aplikasi: http://localhost:${port}`);
});
