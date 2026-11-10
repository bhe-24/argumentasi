// api/evaluate.js — Wrapper kompatibilitas ke api/central.js
const central = require('./central');

module.exports = async function handler(req, res) {
    return central(req, res);
};
module.exports.config = { maxDuration: 30 };
