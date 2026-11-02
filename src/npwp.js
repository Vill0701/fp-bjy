// NPWP dan NITKU dalam bentuk angka saja: 16 dan 22 digit.

/** NPWP 16 digit. Angka 15 digit (format lama, atau 0 di depan hilang karena Excel) diberi 0 di depan. */
export function normalizeNpwp(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 15) return "0" + digits;
  return digits.length === 16 ? digits : null;
}

/** NITKU 22 digit; kosong berarti kantor pusat (NPWP + 000000). */
export function normalizeNitku(value, npwp) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return npwp ? npwp + "000000" : null;
  if (digits.length === 21) return "0" + digits;
  return digits.length === 22 ? digits : null;
}
