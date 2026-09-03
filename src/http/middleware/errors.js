'use strict';

/** Format galat seragam, mengikuti bentuk GoBiz: { success, errors: [...] }. */
function notFound(req, res) {
  res.status(404).json({ success: false, errors: [{ message: `Rute tidak ditemukan: ${req.method} ${req.path}` }] });
}

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    // statusCode yang diset sengaja berarti pesannya memang untuk dibaca
    // pemanggil. Galat tanpa statusCode adalah yang tak terduga: dicatat penuh,
    // tapi hanya pesan umum yang keluar agar detail internal tidak bocor.
    const deliberate = Number.isInteger(err.statusCode);
    const status = deliberate ? err.statusCode : 500;
    if (!deliberate || status >= 500) {
      log(`ERROR ${req.method} ${req.path}: ${err.stack || err.message}`);
    }
    res.status(status).json({
      success: false,
      errors: [{ message: deliberate ? err.message : 'Terjadi kesalahan internal' }],
    });
  };
}

module.exports = { notFound, errorHandler };
