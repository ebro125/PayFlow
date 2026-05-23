const { Worker } = require('bullmq');
const redis = require('../config/redis');
const pool  = require('../config/db');

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
};

const transferWorker = new Worker('transfers', async (job) => {
  const { senderWalletId, receiverWalletId, amount, idempotency_key } = job.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock both wallets
    const { rows: senderRows } = await client.query(
      `SELECT id, balance FROM wallets WHERE id = $1 FOR UPDATE`,
      [senderWalletId]
    );
    if (!senderRows.length) throw new Error('Sender wallet not found');

    const sender = senderRows[0];
    if (parseFloat(sender.balance) < parseFloat(amount)) {
      throw new Error('Insufficient balance');
    }

    const { rows: receiverRows } = await client.query(
      `SELECT id FROM wallets WHERE id = $1 FOR UPDATE`,
      [receiverWalletId]
    );
    if (!receiverRows.length) throw new Error('Receiver wallet not found');

    // Debit / credit
    await client.query(
      `UPDATE wallets SET balance = balance - $1 WHERE id = $2`,
      [amount, senderWalletId]
    );
    await client.query(
      `UPDATE wallets SET balance = balance + $1 WHERE id = $2`,
      [amount, receiverWalletId]
    );

    // Record transaction
    const { rows: txRows } = await client.query(
      `INSERT INTO transactions (sender_wallet_id, receiver_wallet_id, amount, type, status, idempotency_key)
       VALUES ($1, $2, $3, 'transfer', 'completed', $4)
       RETURNING id`,
      [senderWalletId, receiverWalletId, amount, idempotency_key || null]
    );

    await client.query('COMMIT');
    console.log(`✅ Transfer job ${job.id} completed — tx: ${txRows[0].id}`);
    return { transaction_id: txRows[0].id };

  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ Transfer job ${job.id} failed:`, err.message);
    throw err; // BullMQ will retry the job
  } finally {
    client.release();
  }

}, { connection });

transferWorker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

transferWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed: ${err.message}`);
});
console.log('✅ Transfer worker started');
module.exports = transferWorker;