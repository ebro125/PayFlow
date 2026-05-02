const pool = require('../config/db');

// GET /api/wallet/balance
const getBalance = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Wallet not found' });
    res.json({ balance: rows[0].balance });
  } catch (err) {
    next(err);
  }
};

// POST /api/wallet/deposit  { amount }
const deposit = async (req, res, next) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'Amount must be positive' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE wallets SET balance = balance + $1
       WHERE user_id = $2
       RETURNING balance`,
      [amount, req.userId]
    );

    await client.query(
      `INSERT INTO transactions (sender_wallet_id, receiver_wallet_id, amount, type, status)
       VALUES (NULL, (SELECT id FROM wallets WHERE user_id = $1), $2, 'deposit', 'completed')`,
      [req.userId, amount]
    );

    await client.query('COMMIT');
    res.json({ balance: rows[0].balance });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// POST /api/wallet/transfer  { to_email, amount }
const transfer = async (req, res, next) => {
  const { to_email, amount, idempotency_key } = req.body;

  if (!to_email || !amount || amount <= 0) {
    return res.status(400).json({ error: 'to_email and a positive amount are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotency check
    if (idempotency_key) {
      const { rows: existing } = await client.query(
        `SELECT id, status FROM transactions WHERE idempotency_key = $1 LIMIT 1`,
        [idempotency_key]
      );
      if (existing.length) {
        await client.query('ROLLBACK');
        return res.status(200).json({
          message: 'Duplicate request — original transaction returned',
          transaction_id: existing[0].id,
          status: existing[0].status,
        });
      }
    }

    // Sender wallet (lock row)
    const { rows: senderRows } = await client.query(
      `SELECT w.id, w.balance FROM wallets w
       WHERE w.user_id = $1
       FOR UPDATE`,
      [req.userId]
    );
    if (!senderRows.length) throw Object.assign(new Error('Sender wallet not found'), { status: 404 });

    const sender = senderRows[0];
    if (parseFloat(sender.balance) < parseFloat(amount)) {
      throw Object.assign(new Error('Insufficient balance'), { status: 422 });
    }

    // Receiver wallet (lock row)
    const { rows: receiverRows } = await client.query(
      `SELECT w.id FROM wallets w
       JOIN users u ON u.id = w.user_id
       WHERE u.email = $1
       FOR UPDATE`,
      [to_email]
    );
    if (!receiverRows.length) throw Object.assign(new Error('Recipient not found'), { status: 404 });

    const receiver = receiverRows[0];
    if (receiver.id === sender.id) {
      throw Object.assign(new Error('Cannot transfer to yourself'), { status: 400 });
    }

    // Debit / credit
    await client.query(
      `UPDATE wallets SET balance = balance - $1 WHERE id = $2`,
      [amount, sender.id]
    );
    await client.query(
      `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
      [amount, receiver.id]
    );

    // Record transaction
    const { rows: txRows } = await client.query(
      `INSERT INTO transactions (sender_wallet_id, receiver_wallet_id, amount, type, status, idempotency_key)
       VALUES ($1, $2, $3, 'transfer', 'completed', $4)
       RETURNING id`,
      [sender.id, receiver.id, amount, idempotency_key || null]
    );

    await client.query('COMMIT');
    res.json({ transaction_id: txRows[0].id, status: 'completed' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// GET /api/wallet/transactions
const getTransactions = async (req, res, next) => {
  try {
    // Resolve caller's wallet id + current balance in one shot
    const { rows: walletRows } = await pool.query(
      'SELECT id, balance FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    if (!walletRows.length) return res.status(404).json({ error: 'Wallet not found' });

    const walletId = walletRows[0].id;
    const currentBalance = walletRows[0].balance;

    const { rows } = await pool.query(
      `SELECT
         t.id,
         t.type,
         t.amount,
         t.status,
         t.created_at,
         CASE
           WHEN t.type = 'deposit'        THEN 'received'
           WHEN t.sender_wallet_id = $1   THEN 'sent'
           ELSE                                'received'
         END AS direction,
         CASE
           WHEN t.type = 'deposit'        THEN NULL
           WHEN t.sender_wallet_id = $1   THEN receiver_user.full_name
           ELSE                                sender_user.full_name
         END AS other_party
       FROM transactions t
       LEFT JOIN wallets sender_wallet   ON sender_wallet.id   = t.sender_wallet_id
       LEFT JOIN wallets receiver_wallet ON receiver_wallet.id = t.receiver_wallet_id
       LEFT JOIN users   sender_user     ON sender_user.id     = sender_wallet.user_id
       LEFT JOIN users   receiver_user   ON receiver_user.id   = receiver_wallet.user_id
       WHERE t.sender_wallet_id = $1
          OR t.receiver_wallet_id = $1
       ORDER BY t.created_at DESC`,
      [walletId]
    );

    res.json({ current_balance: currentBalance, transactions: rows });
  } catch (err) {
    next(err);
  }
};

module.exports = { getBalance, deposit, transfer, getTransactions };