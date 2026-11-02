// Ambil teks PDF beserta posisinya dalam koordinat halaman yang tampak di layar
// (x ke kanan, y ke bawah). Halaman invoice disimpan dalam keadaan diputar, jadi posisi
// mentah dari PDF harus dikonversi lewat viewport dulu.
//
// `pdfjs` adalah modul PDF.js (versi browser atau Node), dikirim oleh pemanggil.
export async function extractPages(pdfjs, data, options = {}) {
  const task = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0, ...options });
  const doc = await task.promise;
  try {
    const pages = [];
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = [];
      for (const it of content.items) {
        const str = it.str?.trim();
        if (!str) continue;
        const [, , , , x, y] = pdfjs.Util.transform(viewport.transform, it.transform);
        items.push({ str, x, y, w: it.width });
      }
      pages.push({ number, items });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
