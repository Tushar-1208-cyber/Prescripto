import rateLimit from 'express-rate-limit'

// Limits brute-force attempts on login endpoints (user/doctor/admin)
export const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per IP per window
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please try again after 15 minutes.' },
})

export default loginLimiter
