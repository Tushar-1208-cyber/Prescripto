import mongoose from "mongoose";

const webhookEventSchema = new mongoose.Schema({
    provider: {
        type: String,
        enum: ['stripe', 'razorpay'],
        required: true
    },
    eventId: {
        type: String,
        required: true
    },
    eventType: {
        type: String,
        required: true
    },
    resourceId: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ['received', 'processing', 'processed', 'failed'],
        default: 'received'
    },
    appointmentId: {
        type: String,
        default: null
    },
    claimToken: {
        type: String,
        default: null
    },
    claimExpiresAt: {
        type: Date,
        default: null
    },
    retryCount: {
        type: Number,
        default: 0
    },
    failureReason: {
        type: String,
        default: null
    },
    receivedAt: {
        type: Date,
        default: Date.now
    },
    processedAt: {
        type: Date,
        default: null
    }
}, { timestamps: true });

// Compound unique index on provider and eventId ensures no duplicate events per provider
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

// 30-day TTL index to automatically purge historical event logs
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

// Index for query and monitoring
webhookEventSchema.index({ provider: 1, status: 1, createdAt: -1 });

const webhookEventModel = mongoose.models.webhookEvent || mongoose.model("webhookEvent", webhookEventSchema);
export default webhookEventModel;
