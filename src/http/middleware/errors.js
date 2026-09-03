'use strict';

/** Format galat seragam, mengikuti bentuk GoBiz: { success, errors: [...] }. */
function notFound(req, res) {
  res.status(404).json({ success: false, errors: [{ message: `Rute tidak ditemukan: ${req.method} ${req.path}` }] });
}

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const status = err.statusCode || 500;
    // Detail internal tidak pernah dibocorkan ke pemanggil; hanya dicatat.
    if (status >= 500) log(`ERROR ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(status).json({
      success: false,
      errors: [{ message: status >= 500 ? 'Terjadi kesalahan internal' : err.message }],
    });
  };
}

module.exports = { notFound, errorHandler };
