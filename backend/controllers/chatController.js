import messageModel from "../models/messageModel.js";
import appointmentModel from "../models/appointmentModel.js";

// Fetch message history for an appointment
const getMessages = async (req, res) => {
    try {
        const { appointmentId } = req.params;

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: "Appointment ID is required" });
        }

        const appointment = await appointmentModel.findById(appointmentId);
        if (!appointment) {
            return res.status(404).json({ success: false, message: "Appointment not found" });
        }

        const messages = await messageModel.find({ appointmentId }).sort({ timestamp: 1 });
        res.json({ success: true, messages });
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// Send message via HTTP fallback / persist
const sendMessage = async (req, res) => {
    try {
        const { appointmentId, senderId, senderName, senderRole, message } = req.body;

        if (!appointmentId || !senderId || !senderName || !senderRole || !message) {
            return res.status(400).json({ success: false, message: "Missing message parameters" });
        }

        const newMessage = new messageModel({
            appointmentId,
            senderId,
            senderName,
            senderRole,
            message,
            timestamp: Date.now()
        });

        await newMessage.save();
        res.status(201).json({ success: true, messageData: newMessage });
    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, message: error.message });
    }
};

export { getMessages, sendMessage };
