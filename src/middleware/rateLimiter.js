const redis = require('../config/redis');

const WINDOW_SECONDS = 60;
const MAX_REQUESTS   = 5;

const rateLimiter = async (req, res, next) => {
  const key = `rate:transfer:${req.userId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;

  try {
    await redis.zremrangebyscore(key, '-inf', windowStart);
    const count = await redis.zcard(key);

    if (count >= MAX_REQUESTS) {
      const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const resetAt = Math.ceil((parseFloat(oldest[1]) + WINDOW_SECONDS * 1000) / 1000);
      const retryIn = Math.ceil((resetAt * 1000 - now) / 1000);

      return res.status(429).json({
        error: 'Too many transfer requests',
        limit: MAX_REQUESTS,
        window: `${WINDOW_SECONDS}s`,
        retry_after_seconds: retryIn,
      });
    }

    await redis.zadd(key, now, `${now}`);
    await redis.expire(key, WINDOW_SECONDS);

    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', MAX_REQUESTS - count - 1);

    next();
  } catch (err) {
    console.error('Rate limiter error:', err);
    next();
  }
};

module.exports = rateLimiter;