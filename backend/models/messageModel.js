import mongoose from "mongoose";

const messageSchema = new mongoose.Schema({
    appointmentId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    senderRole: { type: String, enum: ['user', 'doctor'], required: true },
    message: { type: String, required: true },
    timestamp: { type: Number, default: Date.now }
});

messageSchema.index({ appointmentId: 1, timestamp: 1 });

const messageModel = mongoose.models.message || mongoose.model("message", messageSchema);
export default messageModel;
