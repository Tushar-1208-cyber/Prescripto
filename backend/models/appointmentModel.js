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
    isCompleted: { type: Boolean, default: false },
    refundStatus: { type: String, default: 'none' }, // 'none', 'refunded'
    reminderSent24h: { type: Boolean, default: false },
    reminderSent1h: { type: Boolean, default: false },
    receiptSent: { type: Boolean, default: false },
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

const appointmentModel = mongoose.models.appointment || mongoose.model("appointment", appointmentSchema)
export default appointmentModel