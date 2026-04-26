const express = require('express');
const pool    = require('../config/db');
const router  = express.Router();

// GET /api/health
router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ success: true, message: 'Server and DB are up' });
  } catch (err) {
    res.status(503).json({ success: false, message: 'DB not reachable' });
  }
});

module.exports = router;