const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const pool   = require('../config/db');

// POST /api/auth/register
const register = async (req, res, next) => {
  const { full_name, email, password } = req.body;

  try {
    // 1. Check if email already exists
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // 2. Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Create user AND wallet in one transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const userResult = await client.query(
        `INSERT INTO users (full_name, email, password)
         VALUES ($1, $2, $3)
         RETURNING id, full_name, email, created_at`,
        [full_name, email, hashedPassword]
      );
      const user = userResult.rows[0];

      await client.query(
        `INSERT INTO wallets (user_id) VALUES ($1)`,
        [user.id]
      );

      await client.query('COMMIT');

      // 4. Issue JWT
      const token = jwt.sign(
        { userId: user.id },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        success: true,
        message: 'User registered successfully',
        token,
        user: { id: user.id, full_name: user.full_name, email: user.email },
      });

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

  } catch (err) {
    next(err);
  }
};

// POST /api/auth/login
const login = async (req, res, next) => {
  const { email, password } = req.body;

  try {
    // 1. Find user
    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // 2. Compare password
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    // 3. Issue JWT
    const token = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email },
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { register, login };