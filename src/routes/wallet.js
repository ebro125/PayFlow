// const router = require('express').Router();
// const { getBalance, deposit, transfer, getTransactions } = require('../controllers/walletController');
// const protect = require('../middleware/authMiddleware');

// const rateLimiter = require('../middleware/rateLimiter');
// router.use(protect); // all wallet routes require JWT

// router.get('/balance',      getBalance);
// router.post('/deposit',     deposit);
// router.post('/transfer',    rateLimiter, transfer); // ← rate limited
// router.get('/transactions', getTransactions); // ← Step 5

// module.exports = router;

const router = require('express').Router();
const { getBalance, deposit, transfer, getTransactions } = require('../controllers/walletController');
const protect     = require('../middleware/authMiddleware');
const rateLimiter = require('../middleware/rateLimiter');

router.use(protect);

router.get('/balance',      getBalance);
router.post('/deposit',     deposit);
router.post('/transfer',    rateLimiter, transfer);
router.get('/transactions', getTransactions);

module.exports = router;