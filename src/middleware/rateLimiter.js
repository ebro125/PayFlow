const redis = require('../config/redis');

const WINDOW_SECONDS = 60;  // 1 minute window
const MAX_REQUESTS   = 5;   // max transfers per window

const rateLimiter = async (req, res, next) => {
  const key = `rate:transfer:${req.userId}`;
  const now = Date.now();
  const windowStart = now - WINDOW_SECONDS * 1000;

  try {
    // Remove timestamps outside the current window
    await redis.zremrangebyscore(key, '-inf', windowStart);

    // Count how many requests are in the current window
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

    // Add current request timestamp to the sorted set
    await redis.zadd(key, now, `${now}`);

    // Set expiry on the key so Redis cleans up idle users
    await redis.expire(key, WINDOW_SECONDS);

    // Pass remaining info to response headers
    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
    res.setHeader('X-RateLimit-Remaining', MAX_REQUESTS - count - 1);

    next();
  } catch (err) {
    // If Redis is down, fail open (don't block transfers)
    console.error('Rate limiter error:', err);
    next();
  }
};

module.exports = rateLimiter;