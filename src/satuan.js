// Padanan satuan di invoice → kode satuan Coretax, mengikuti XML yang selama ini dibuat pengguna.
// Padanan yang diubah di aplikasi (tersimpan di perangkat) boleh menambah atau menimpa daftar ini.
export const DEFAULT_UNITS = {
  PCS: "UM.0021", // Piece
  PIECE: "UM.0021",
  BH: "UM.0021",
  KLG: "UM.0021",
  BTG: "UM.0021",
  BTL: "UM.0021",
  LBR: "UM.0020", // Lembar
  LS: "UM.0017", // Lusin
  SET: "UM.0019", // Set
  MTR: "UM.0013", // Meter
  M: "UM.0013",
  KG: "UM.0003", // Kilogram
  ROL: "UM.0039", // Roll
  TUBE: "UM.0033", // Lainnya
};

// Daftar satuan ukur dari template Excel Coretax (sheet referensi).
export const UNIT_NAMES = {
  "UM.0001": "Metrik Ton",
  "UM.0002": "Wet Ton",
  "UM.0003": "Kilogram",
  "UM.0004": "Gram",
  "UM.0005": "Karat",
  "UM.0006": "Kiloliter",
  "UM.0007": "Liter",
  "UM.0008": "Barrel",
  "UM.0009": "MMBTU",
  "UM.0010": "Ampere",
  "UM.0011": "Sentimeter Kubik",
  "UM.0012": "Meter Persegi",
  "UM.0013": "Meter",
  "UM.0014": "Inci",
  "UM.0015": "Sentimeter",
  "UM.0016": "Yard",
  "UM.0017": "Lusin",
  "UM.0018": "Unit",
  "UM.0019": "Set",
  "UM.0020": "Lembar",
  "UM.0021": "Piece",
  "UM.0022": "Boks",
  "UM.0023": "Tahun",
  "UM.0024": "Bulan",
  "UM.0025": "Minggu",
  "UM.0026": "Hari",
  "UM.0027": "Jam",
  "UM.0028": "Menit",
  "UM.0029": "Persen",
  "UM.0030": "Kegiatan",
  "UM.0031": "Laporan",
  "UM.0032": "Bahan",
  "UM.0033": "Lainnya",
  "UM.0034": "Meter Kubik",
  "UM.0035": "Sentimeter Persegi",
  "UM.0036": "Drum",
  "UM.0037": "Karton",
  "UM.0038": "Kwh",
  "UM.0039": "Roll",
};

// Kode transaksi dari template Excel Coretax.
export const TRX_CODES = {
  "01": "Kepada selain Pemungut PPN",
  "02": "Kepada Pemungut PPN Instansi Pemerintah",
  "03": "Kepada Pemungut PPN selain Instansi Pemerintah",
  "04": "DPP Nilai Lain",
  "05": "Besaran tertentu",
  "06": "Kepada orang pribadi pemegang paspor luar negeri",
  "07": "Fasilitas PPN tidak dipungut / ditanggung pemerintah",
  "08": "Fasilitas dibebaskan PPN",
  "09": "Penyerahan aktiva (16D UU PPN)",
  "10": "Penyerahan lainnya",
};

export const normalizeUnit = (unit) => unit.trim().toUpperCase();
