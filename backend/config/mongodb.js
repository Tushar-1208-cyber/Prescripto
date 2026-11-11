import mongoose from "mongoose";

// Track event listeners to ensure they are registered only once
let listenersRegistered = false;

const registerConnectionListeners = () => {
    if (listenersRegistered) return;
    listenersRegistered = true;

    mongoose.connection.on("connected", () => {
        console.log("Database Connected Successfully");
    });

    mongoose.connection.on("disconnected", () => {
        console.warn("[mongodb] Database connection lost");
    });

    mongoose.connection.on("reconnected", () => {
        console.log("[mongodb] Database reconnected successfully");
    });

    mongoose.connection.on("error", (err) => {
        console.error("[mongodb] Connection error:", err.message);
    });
};

/**
 * Resolves normalized MongoDB URI with prescripto database name.
 */
export const resolveMongoUri = (rawUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017") => {
    let uri = (rawUri || "mongodb://127.0.0.1:27017").replace(/^["']|["']$/g, '').trim();
    if (!uri.includes("prescripto")) {
        if (uri.includes("?")) {
            const parts = uri.split("?");
            uri = `${parts[0].replace(/\/$/, '')}/prescripto?${parts[1]}`;
        } else {
            uri = uri.endsWith("/") ? `${uri}prescripto` : `${uri}/prescripto`;
        }
    }
    return uri;
};

/**
 * Connects to MongoDB with configurable exponential backoff retry.
 */
export const connectDB = async (options = {}) => {
    registerConnectionListeners();

    // If already connected, return existing connection
    if (mongoose.connection.readyState === 1) {
        return mongoose.connection;
    }

    const uri = resolveMongoUri(options.uri);
    const maxRetries = options.maxRetries ?? 5;
    const initialDelayMs = options.initialDelayMs ?? 1000;
    const maxDelayMs = options.maxDelayMs ?? 10000;
    const serverSelectionTimeoutMS = options.serverSelectionTimeoutMS ?? 5000;

    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await mongoose.connect(uri, {
                serverSelectionTimeoutMS,
                ...options.mongooseOptions
            });
            return mongoose.connection;
        } catch (error) {
            lastError = error;
            console.error(`[mongodb] Connection attempt ${attempt}/${maxRetries} failed: ${error.message}`);

            if (attempt >= maxRetries) {
                console.error("[mongodb] All connection retries exhausted.");
                throw error;
            }

            const backoff = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
            const jitter = Math.floor(Math.random() * 200);
            const delay = backoff + jitter;

            console.log(`[mongodb] Retrying connection in ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }

    throw lastError;
};

/**
 * Checks whether MongoDB is currently connected and ready.
 * readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
 */
export const isDbConnected = () => {
    return mongoose.connection.readyState === 1;
};

/**
 * Closes MongoDB connection cleanly for graceful shutdown.
 */
export const closeDBConnection = async () => {
    if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close(false);
    }
};

export default connectDB;
