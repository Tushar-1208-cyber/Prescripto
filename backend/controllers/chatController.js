import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import messageModel from "../models/messageModel.js";
import appointmentModel from "../models/appointmentModel.js";

/**
 * Middleware: Authenticates caller as either the assigned patient or assigned doctor
 * for the requested appointment.
 * Never trusts client-supplied senderId, userId, or docId.
 */
export const authChatParticipant = async (req, res, next) => {
    try {
        const appointmentId = req.params.appointmentId || req.body.appointmentId;

        if (!appointmentId || !mongoose.Types.ObjectId.isValid(appointmentId)) {
            return res.status(400).json({ success: false, message: "Valid Appointment ID is required" });
        }

        const authHeader = req.headers.authorization;
        const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
        const token = req.headers.token || req.headers.dtoken || bearerToken;

        if (!token) {
            return res.status(401).json({ success: false, message: "Authentication token required" });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch (jwtError) {
            return res.status(401).json({ success: false, message: "Invalid or expired authentication token" });
        }

        if (!decoded || !decoded.id) {
            return res.status(401).json({ success: false, message: "Invalid token payload" });
        }

        const appointment = await appointmentModel.findById(appointmentId);
        if (!appointment) {
            return res.status(404).json({ success: false, message: "Appointment not found" });
        }

        const isPatient = appointment.userId.toString() === decoded.id.toString();
        const isDoctor = appointment.docId.toString() === decoded.id.toString();

        if (!isPatient && !isDoctor) {
            return res.status(403).json({
                success: false,
                message: "Unauthorized: You are not an assigned participant for this appointment"
            });
        }

        req.appointment = appointment;
        req.participant = {
            id: decoded.id.toString(),
            role: isPatient ? 'user' : 'doctor',
            name: isPatient
                ? (appointment.userData?.name || 'Patient')
                : `Dr. ${appointment.docData?.name || 'Doctor'}`
        };

        next();
    } catch (error) {
        console.error("[chatController] authChatParticipant error:", error.message);
        res.status(500).json({ success: false, message: "Internal server error during chat authorization" });
    }
};

/**
 * Fetch message history for an authorized appointment
 */
export const getMessages = async (req, res) => {
    try {
        const messages = await messageModel.find({
            appointmentId: req.appointment._id.toString()
        }).sort({ timestamp: 1 });

        res.json({ success: true, messages });
    } catch (error) {
        console.error("[chatController] getMessages error:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Send message via HTTP fallback / persist
 * Derives sender identity exclusively from verified JWT participant metadata.
 */
export const sendMessage = async (req, res) => {
    try {
        const { message } = req.body || {};

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, message: "Message text is required" });
        }

        const trimmed = message.trim();
        if (trimmed.length > 2000) {
            return res.status(400).json({ success: false, message: "Message exceeds maximum allowed length of 2000 characters" });
        }

        const newMessage = new messageModel({
            appointmentId: req.appointment._id.toString(),
            senderId: req.participant.id,
            senderName: req.participant.name,
            senderRole: req.participant.role,
            message: trimmed,
            timestamp: Date.now()
        });

        await newMessage.save();
        res.status(201).json({ success: true, messageData: newMessage });
    } catch (error) {
        console.error("[chatController] sendMessage error:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

export default { authChatParticipant, getMessages, sendMessage };
