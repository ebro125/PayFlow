const pool          = require('../config/db');
const transferQueue = require('../queues/transferQueue');

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

  // FIX: validate amount is actually a number, not just truthy
  const parsed = parseFloat(amount);
  if (!amount || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE wallets SET balance = balance + $1
       WHERE user_id = $2
       RETURNING balance`,
      [parsed, req.userId]
    );

    await client.query(
      `INSERT INTO transactions (sender_wallet_id, receiver_wallet_id, amount, type, status)
       VALUES (NULL, (SELECT id FROM wallets WHERE user_id = $1), $2, 'deposit', 'completed')`,
      [req.userId, parsed]
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

// POST /api/wallet/transfer  { to_email, amount, idempotency_key? }
const transfer = async (req, res, next) => {
  const { to_email, amount, idempotency_key } = req.body;

  const parsed = parseFloat(amount);
  if (!to_email || !amount || isNaN(parsed) || parsed <= 0) {
    return res.status(400).json({ error: 'to_email and a positive amount are required' });
  }

  const client = await pool.connect();
  try {
    // Fetch sender wallet
    const { rows: senderRows } = await client.query(
      `SELECT w.id, w.balance FROM wallets w WHERE w.user_id = $1`,
      [req.userId]
    );
    if (!senderRows.length) return res.status(404).json({ error: 'Sender wallet not found' });
    const sender = senderRows[0];

    // Idempotency check — scoped to sender
    if (idempotency_key) {
      const { rows: existing } = await client.query(
        `SELECT id, status FROM transactions
         WHERE idempotency_key = $1 AND sender_wallet_id = $2
         LIMIT 1`,
        [idempotency_key, sender.id]
      );
      if (existing.length) {
        return res.status(200).json({
          message: 'Duplicate request — original transaction returned',
          transaction_id: existing[0].id,
          status: existing[0].status,
        });
      }
    }

    // Balance check
    if (parseFloat(sender.balance) < parsed) {
      return res.status(422).json({ error: 'Insufficient balance' });
    }

    // Fetch receiver wallet
    const { rows: receiverRows } = await client.query(
      `SELECT w.id FROM wallets w
       JOIN users u ON u.id = w.user_id
       WHERE u.email = $1`,
      [to_email]
    );
    if (!receiverRows.length) return res.status(404).json({ error: 'Recipient not found' });
    const receiver = receiverRows[0];

    if (receiver.id === sender.id) {
      return res.status(400).json({ error: 'Cannot transfer to yourself' });
    }

    // Add job to queue — don't wait for it to complete
    const job = await transferQueue.add('transfer', {
      senderWalletId:   sender.id,
      receiverWalletId: receiver.id,
      amount:           parsed,
      idempotency_key:  idempotency_key || null,
    });

    // Return immediately — worker handles the rest
    res.status(202).json({
      message:    'Transfer queued',
      job_id:     job.id,
      status:     'queued',
    });

  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
};

// GET /api/wallet/transactions
const getTransactions = async (req, res, next) => {
  try {
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