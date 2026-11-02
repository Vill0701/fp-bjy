// Semua nilai uang dihitung dalam sen (bilangan bulat) supaya tidak ada galat pembulatan desimal.

export const toSen = (n) => Math.round(n * 100);

/** round(n ÷ d) untuk BigInt, pembulatan setengah menjauhi nol. */
function divRound(n, d) {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const negative = n < 0n;
  if (negative) n = -n;
  let q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return Number(negative ? -q : q);
}

/** round(a × b ÷ c) dengan pembulatan setengah ke atas, dihitung eksak (BigInt). a, b, c bilangan bulat. */
export const mulDiv = (a, b, c) => divRound(BigInt(a) * BigInt(b), BigInt(c));

/** round(hasil kali `nums` ÷ hasil kali `dens`), dihitung eksak (BigInt). Semua faktor bilangan bulat. */
export function ratio(nums, dens) {
  const product = (factors) => factors.reduce((acc, f) => acc * BigInt(f), 1n);
  return divRound(product(nums), product(dens));
}

/** Angka untuk XML: tanpa desimal kalau bulat, selain itu maksimal 2 desimal (9166.67, 123.5). */
export function formatSen(sen) {
  const abs = Math.abs(sen);
  const frac = abs % 100;
  let s = String(Math.floor(abs / 100));
  if (frac) s += "." + String(frac).padStart(2, "0").replace(/0$/, "");
  return (sen < 0 ? "-" : "") + s;
}

export const formatQty = (qty) => String(Number(qty.toFixed(4)));

/** Untuk pesan ke pengguna: "Rp 3.170.000", "Rp 297.297,30". */
export const rupiah = (sen) =>
  "Rp " + (sen / 100).toLocaleString("id-ID", { minimumFractionDigits: sen % 100 ? 2 : 0, maximumFractionDigits: 2 });
