// Menyimpan salinan file aplikasi supaya tetap bisa dibuka saat sinyal lemah.
// Hanya file dari server aplikasi ini yang disimpan.
const CACHE = "fp-bjy-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  // Aplikasi lain di alamat yang sama (FP MMM) punya cache sendiri; yang dihapus hanya versi lama cache ini.
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("fp-bjy-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  // Selalu ambil versi terbaru dulu; salinan hanya dipakai kalau sedang offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? Response.error())),
  );
});
