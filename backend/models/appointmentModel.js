import mongoose from "mongoose"

const appointmentSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    docId: { type: String, required: true },
    slotDate: { type: String, required: true },
    slotTime: { type: String, required: true },
    userData: { type: Object, required: true },
    docData: { type: Object, required: true },
    amount: { type: Number, required: true },
    date: { type: Number, required: true },
    cancelled: { type: Boolean, default: false },
    payment: { type: Boolean, default: false },
    paymentMode: { type: String, enum: ['online', 'cash'], default: 'online' },
    isCash: { type: Boolean, default: false },
    isCompleted: { type: Boolean, default: false },
    refundStatus: {
        type: String,
        enum: ['none', 'not_applicable', 'pending', 'processing', 'refunded', 'failed'],
        default: 'none'
    },
    // Refund Lifecycle Fields (Phase 4 Task 4.2)
    refundId: { type: String, default: null },
    refundAmount: { type: Number, default: null },
    refundAmountMinor: { type: Number, default: null },
    refundCurrency: { type: String, default: null },
    refundedAt: { type: Date, default: null },
    refundClaimedAt: { type: Date, default: null },
    refundFailureReason: { type: String, default: null },
    refundAttempts: { type: Number, default: 0 },
    refundIdempotencyKey: { type: String, default: null },
    refundProviderStatus: { type: String, default: null },
    // Payment identifier persistence (Phase 4 Task 4.1)
    paymentMethod: { type: String, enum: ['razorpay', 'stripe', 'cash', null], default: null },
    paymentId: { type: String, default: null },
    orderId: { type: String, default: null },
    checkoutSessionId: { type: String, default: null },
    paymentCurrency: { type: String, default: null },
    paymentAmountMinor: { type: Number, default: null },
    paymentCapturedAt: { type: Date, default: null },
    reminderSent24h: { type: Boolean, default: false },
    reminder24hStatus: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending' },
    reminder24hClaimedAt: { type: Date, default: null },
    reminderSent1h: { type: Boolean, default: false },
    reminder1hStatus: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending' },
    reminder1hClaimedAt: { type: Date, default: null },
    receiptSent: { type: Boolean, default: false },
    receiptStatus: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], default: 'pending' },
    receiptClaimedAt: { type: Date, default: null },
    prescription: {
        diagnosis: { type: String, default: '' },
        notes: { type: String, default: '' },
        medicines: [{
            name: { type: String, default: '' },
            dosage: { type: String, default: '' },
            frequency: { type: String, default: '' }
        }],
        dateIssued: { type: Number, default: 0 }
    }
})

// Compound partial unique index: ensures no two active (non-cancelled) appointments can share the same doctor + slot
appointmentSchema.index(
    { docId: 1, slotDate: 1, slotTime: 1 },
    { unique: true, partialFilterExpression: { cancelled: false } }
)

// Database performance indexes
appointmentSchema.index({ userId: 1 })
appointmentSchema.index({ docId: 1 })
appointmentSchema.index({ slotDate: 1 })
appointmentSchema.index({ paymentId: 1 }, { sparse: true })
appointmentSchema.index({ refundId: 1 }, { sparse: true })

const appointmentModel = mongoose.models.appointment || mongoose.model("appointment", appointmentSchema)
export default appointmentModel