/**
 * Validates environment variables at application startup.
 * Enforces mandatory variables to fail fast with clear errors.
 * Never logs actual secret values, credentials, or connection strings.
 */

const MANDATORY_VARS = [
    { key: "JWT_SECRET", description: "JSON Web Token secret key for user/doctor/admin authentication" },
    { key: "ADMIN_EMAIL", description: "Administrator account email address" },
    { key: "MONGODB_URI", description: "MongoDB connection string" }
];

export const validateEnv = (env = process.env) => {
    const missing = [];

    for (const { key, description } of MANDATORY_VARS) {
        if (!env[key] || typeof env[key] !== "string" || !env[key].trim()) {
            missing.push(`${key} (${description})`);
        }
    }

    // Either ADMIN_PASSWORD or ADMIN_PASSWORD_HASH must be configured
    const hasAdminPass = Boolean(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.trim());
    const hasAdminHash = Boolean(env.ADMIN_PASSWORD_HASH && env.ADMIN_PASSWORD_HASH.trim());
    if (!hasAdminPass && !hasAdminHash) {
        missing.push("ADMIN_PASSWORD or ADMIN_PASSWORD_HASH (Administrator account password credentials)");
    }

    if (missing.length > 0) {
        const errorMsg = `[validateEnv] Fatal Configuration Error: Missing required environment variable(s):\n  - ${missing.join("\n  - ")}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Optional integration warnings (non-fatal)
    const optionalWarnings = [];
    if (!env.STRIPE_SECRET_KEY) optionalWarnings.push("STRIPE_SECRET_KEY (Stripe online payment processing will be unavailable)");
    if (!env.STRIPE_WEBHOOK_SECRET) optionalWarnings.push("STRIPE_WEBHOOK_SECRET (Stripe webhook verification will be unavailable)");
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) optionalWarnings.push("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET (Razorpay online payment processing will be unavailable)");
    if (!env.RAZORPAY_WEBHOOK_SECRET) optionalWarnings.push("RAZORPAY_WEBHOOK_SECRET (Razorpay webhook verification will be unavailable)");
    if (!env.SMTP_USER || !env.SMTP_PASS) optionalWarnings.push("SMTP_USER / SMTP_PASS (Email notifications will be safely skipped)");
    if (!env.CLOUDINARY_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_SECRET_KEY) optionalWarnings.push("CLOUDINARY_* (Image uploads will operate in unconfigured mode)");

    if (optionalWarnings.length > 0 && process.env.NODE_ENV !== "test") {
        console.warn(`[validateEnv] Note: Optional integrations not configured:\n  - ${optionalWarnings.join("\n  - ")}`);
    }

    return true;
};

export default validateEnv;
