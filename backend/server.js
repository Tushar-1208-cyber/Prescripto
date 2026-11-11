import express from "express"
import http from "http"
import { Server as SocketIOServer } from "socket.io"
import cors from 'cors'
import helmet from 'helmet'
import jwt from "jsonwebtoken"
import 'dotenv/config'
import connectDB from "./config/mongodb.js"
import connectCloudinary from "./config/cloudinary.js"
import userRouter from "./routes/userRoute.js"
import doctorRouter from "./routes/doctorRoute.js"
import adminRouter from "./routes/adminRoute.js"
import chatRouter from "./routes/chatRoute.js"
import videoRouter from "./routes/videoRoute.js"
import recommendationRouter from "./routes/recommendationRoute.js"
import webhookRouter from "./routes/webhookRoute.js"
import messageModel from "./models/messageModel.js"
import appointmentModel from "./models/appointmentModel.js"
import { initReminderScheduler } from "./services/scheduler.js"

// app config
const app = express()
const port = process.env.PORT || 4000
const httpServer = http.createServer(app)

// CORS configuration supporting development and configurable production origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000']

// Real-time Socket.io server with CORS restricted to configured allowed origins
const io = new SocketIOServer(httpServer, {
    cors: {
        origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
                return callback(null, true)
            }
            return callback(new Error('Blocked by CORS policy'))
        },
        methods: ["GET", "POST"],
        credentials: true
    }
})

// In-memory active video consultation rooms: appointmentId -> Map<socketId, participantData>
const videoRooms = new Map()

// Helper to authenticate video session token
const verifyVideoSession = (sessionToken, appointmentId) => {
    if (!sessionToken || !appointmentId) return null
    try {
        const decoded = jwt.verify(sessionToken, process.env.JWT_SECRET)
        if (decoded.appointmentId !== appointmentId.toString()) return null
        return decoded
    } catch {
        return null
    }
}

// Helper to authenticate chat user token (patient or doctor)
const verifyChatToken = (token) => {
    if (!token) return null
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        if (decoded && decoded.id) {
            return decoded.id.toString()
        }
        return null
    } catch {
        return null
    }
}

io.on("connection", (socket) => {
    // Authenticated text chat handlers
    socket.on("join_room", async (data) => {
        try {
            const appointmentId = typeof data === 'object' && data !== null ? data.appointmentId : data
            const token = (typeof data === 'object' && data !== null && (data.token || data.dtoken))
                || socket.handshake.auth?.token
                || socket.handshake.auth?.dtoken
                || socket.handshake.headers?.token
                || socket.handshake.headers?.dtoken

            if (!appointmentId) {
                return socket.emit("chat_error", { message: "Appointment ID is required" })
            }

            const callerId = verifyChatToken(token)
            if (!callerId) {
                return socket.emit("chat_error", { message: "Authentication required to join chat" })
            }

            const appointment = await appointmentModel.findById(appointmentId)
            if (!appointment) {
                return socket.emit("chat_error", { message: "Appointment not found" })
            }

            const isPatient = appointment.userId.toString() === callerId
            const isDoctor = appointment.docId.toString() === callerId

            if (!isPatient && !isDoctor) {
                return socket.emit("chat_error", {
                    message: "Unauthorized: You are not an assigned participant for this appointment"
                })
            }

            const role = isPatient ? 'user' : 'doctor'
            const name = isPatient
                ? (appointment.userData?.name || 'Patient')
                : `Dr. ${appointment.docData?.name || 'Doctor'}`

            if (!socket.chatAuthorizedRooms) {
                socket.chatAuthorizedRooms = new Map()
            }
            socket.chatAuthorizedRooms.set(appointmentId.toString(), {
                participantId: callerId,
                role,
                name
            })

            socket.join(`room_${appointmentId}`)
            socket.emit("room_joined", { appointmentId, role, name })
        } catch (error) {
            console.error("Socket error on join_room:", error.message)
            socket.emit("chat_error", { message: "Error joining chat room" })
        }
    })

    socket.on("send_message", async (data) => {
        try {
            const { appointmentId, message } = data || {}
            if (!appointmentId || !message || typeof message !== 'string' || !message.trim()) {
                return socket.emit("chat_error", { message: "Appointment ID and message text are required" })
            }

            const trimmed = message.trim()
            if (trimmed.length > 2000) {
                return socket.emit("chat_error", { message: "Message exceeds maximum allowed length of 2000 characters" })
            }

            let participant = socket.chatAuthorizedRooms?.get(appointmentId.toString())

            if (!participant) {
                const token = (data && (data.token || data.dtoken))
                    || socket.handshake.auth?.token
                    || socket.handshake.auth?.dtoken
                    || socket.handshake.headers?.token
                    || socket.handshake.headers?.dtoken

                const callerId = verifyChatToken(token)
                if (!callerId) {
                    return socket.emit("chat_error", { message: "Authentication required to send chat message" })
                }

                const appointment = await appointmentModel.findById(appointmentId)
                if (!appointment) {
                    return socket.emit("chat_error", { message: "Appointment not found" })
                }

                const isPatient = appointment.userId.toString() === callerId
                const isDoctor = appointment.docId.toString() === callerId

                if (!isPatient && !isDoctor) {
                    return socket.emit("chat_error", {
                        message: "Unauthorized: You are not an assigned participant for this appointment"
                    })
                }

                const role = isPatient ? 'user' : 'doctor'
                const name = isPatient
                    ? (appointment.userData?.name || 'Patient')
                    : `Dr. ${appointment.docData?.name || 'Doctor'}`

                participant = { participantId: callerId, role, name }
                if (!socket.chatAuthorizedRooms) {
                    socket.chatAuthorizedRooms = new Map()
                }
                socket.chatAuthorizedRooms.set(appointmentId.toString(), participant)
                socket.join(`room_${appointmentId}`)
            }

            // Derive sender details exclusively from verified participant metadata
            const newMessage = new messageModel({
                appointmentId: appointmentId.toString(),
                senderId: participant.participantId,
                senderName: participant.name,
                senderRole: participant.role,
                message: trimmed,
                timestamp: Date.now()
            })

            await newMessage.save()
            io.to(`room_${appointmentId}`).emit("receive_message", newMessage)
        } catch (error) {
            console.error("Socket error on send_message:", error.message)
            socket.emit("chat_error", { message: "Failed to send message" })
        }
    })

    socket.on("leave_room", (data) => {
        try {
            const appointmentId = typeof data === 'object' && data !== null ? data.appointmentId : data
            if (appointmentId) {
                socket.leave(`room_${appointmentId}`)
                if (socket.chatAuthorizedRooms) {
                    socket.chatAuthorizedRooms.delete(appointmentId.toString())
                }
            }
        } catch (err) {
            console.error("Socket error on leave_room:", err.message)
        }
    })

    // Secure WebRTC Video Consultation signaling handlers
    socket.on("join_video_room", (payload) => {
        try {
            const { appointmentId, sessionToken } = payload || {}
            const decoded = verifyVideoSession(sessionToken, appointmentId)

            if (!decoded) {
                return socket.emit("video_room_error", { message: "Unauthorized video session token" })
            }

            // Only 'patient' and 'doctor' roles are recognized
            if (decoded.role !== 'patient' && decoded.role !== 'doctor') {
                return socket.emit("video_room_error", { message: "Invalid participant role" })
            }

            let roomParticipants = videoRooms.get(appointmentId)
            if (!roomParticipants) {
                roomParticipants = new Map()
                videoRooms.set(appointmentId, roomParticipants)
            }

            // Enforce max 2 participants per appointment (Patient and Doctor)
            if (roomParticipants.size >= 2 && !roomParticipants.has(socket.id)) {
                return socket.emit("video_room_error", { message: "Consultation room is full (maximum 2 participants)" })
            }

            // Enforce role exclusivity: two sockets belonging to the same role cannot occupy both slots
            for (const [existingSocketId, existingParticipant] of roomParticipants.entries()) {
                if (existingSocketId !== socket.id && existingParticipant.role === decoded.role) {
                    return socket.emit("video_room_error", {
                        message: `A participant with the role '${decoded.role}' is already present in this consultation.`
                    })
                }
            }

            // Record participant metadata
            roomParticipants.set(socket.id, {
                participantId: decoded.participantId,
                role: decoded.role,
                name: decoded.name
            })
            socket.appointmentVideoRoom = appointmentId
            socket.join(`video_${appointmentId}`)

            console.log(`[video] ${decoded.role} (${decoded.name}) joined video room for appointment ${appointmentId}`)

            // Notify joining participant
            socket.emit("video_room_joined", {
                appointmentId,
                participant: { role: decoded.role, name: decoded.name },
                participantsCount: roomParticipants.size
            })

            // Notify other peer in the room
            socket.to(`video_${appointmentId}`).emit("peer_joined", {
                participantId: decoded.participantId,
                role: decoded.role,
                name: decoded.name
            })

            // If both Doctor and Patient are now present in the room, signal ready
            if (roomParticipants.size === 2) {
                io.to(`video_${appointmentId}`).emit("both_peers_ready", { appointmentId })
            }
        } catch (err) {
            console.error("[video] Error in join_video_room:", err.message)
            socket.emit("video_room_error", { message: err.message })
        }
    })

    socket.on("video_offer", (payload) => {
        try {
            const { appointmentId, sessionToken, sdp } = payload || {}
            const decoded = verifyVideoSession(sessionToken, appointmentId)
            if (!decoded || !sdp) return

            const roomParticipants = videoRooms.get(appointmentId)
            if (!roomParticipants || !roomParticipants.has(socket.id)) {
                return socket.emit("video_room_error", { message: "Sender is not a joined participant in this room" })
            }

            // Verify sender identity and role to prevent impersonation
            const registeredSender = roomParticipants.get(socket.id)
            if (registeredSender.participantId !== decoded.participantId || registeredSender.role !== decoded.role) {
                return socket.emit("video_room_error", { message: "Participant identity mismatch" })
            }

            // Target specifically the opposite peer socket in the room
            let peerSocketId = null
            for (const [sId] of roomParticipants.entries()) {
                if (sId !== socket.id) {
                    peerSocketId = sId
                    break
                }
            }

            if (peerSocketId) {
                io.to(peerSocketId).emit("video_offer", {
                    sdp,
                    senderRole: decoded.role,
                    senderName: decoded.name
                })
            }
        } catch (err) {
            console.error("[video] Error in video_offer:", err.message)
        }
    })

    socket.on("video_answer", (payload) => {
        try {
            const { appointmentId, sessionToken, sdp } = payload || {}
            const decoded = verifyVideoSession(sessionToken, appointmentId)
            if (!decoded || !sdp) return

            const roomParticipants = videoRooms.get(appointmentId)
            if (!roomParticipants || !roomParticipants.has(socket.id)) {
                return socket.emit("video_room_error", { message: "Sender is not a joined participant in this room" })
            }

            // Verify sender identity and role to prevent impersonation
            const registeredSender = roomParticipants.get(socket.id)
            if (registeredSender.participantId !== decoded.participantId || registeredSender.role !== decoded.role) {
                return socket.emit("video_room_error", { message: "Participant identity mismatch" })
            }

            // Target specifically the opposite peer socket in the room
            let peerSocketId = null
            for (const [sId] of roomParticipants.entries()) {
                if (sId !== socket.id) {
                    peerSocketId = sId
                    break
                }
            }

            if (peerSocketId) {
                io.to(peerSocketId).emit("video_answer", {
                    sdp,
                    senderRole: decoded.role,
                    senderName: decoded.name
                })
            }
        } catch (err) {
            console.error("[video] Error in video_answer:", err.message)
        }
    })

    socket.on("new_ice_candidate", (payload) => {
        try {
            const { appointmentId, sessionToken, candidate } = payload || {}
            const decoded = verifyVideoSession(sessionToken, appointmentId)
            if (!decoded || !candidate) return

            const roomParticipants = videoRooms.get(appointmentId)
            if (!roomParticipants || !roomParticipants.has(socket.id)) {
                return socket.emit("video_room_error", { message: "Sender is not a joined participant in this room" })
            }

            // Verify sender identity and role to prevent impersonation
            const registeredSender = roomParticipants.get(socket.id)
            if (registeredSender.participantId !== decoded.participantId || registeredSender.role !== decoded.role) {
                return socket.emit("video_room_error", { message: "Participant identity mismatch" })
            }

            // Target specifically the opposite peer socket in the room
            let peerSocketId = null
            for (const [sId] of roomParticipants.entries()) {
                if (sId !== socket.id) {
                    peerSocketId = sId
                    break
                }
            }

            if (peerSocketId) {
                io.to(peerSocketId).emit("new_ice_candidate", { candidate })
            }
        } catch (err) {
            console.error("[video] Error in new_ice_candidate:", err.message)
        }
    })

    socket.on("leave_video_call", (payload) => {
        try {
            const { appointmentId, sessionToken } = payload || {}
            const decoded = verifyVideoSession(sessionToken, appointmentId)

            if (appointmentId && videoRooms.has(appointmentId)) {
                const roomParticipants = videoRooms.get(appointmentId)
                const participantData = roomParticipants.get(socket.id)
                const senderName = participantData ? participantData.name : (decoded ? decoded.name : 'Participant')
                roomParticipants.delete(socket.id)
                socket.leave(`video_${appointmentId}`)
                io.to(`video_${appointmentId}`).emit("peer_left", {
                    message: `${senderName} has left the call`
                })

                if (roomParticipants.size === 0) {
                    videoRooms.delete(appointmentId)
                }
            }
        } catch (err) {
            console.error("[video] Error in leave_video_call:", err.message)
        }
    })

    socket.on("disconnect", () => {
        try {
            if (socket.chatAuthorizedRooms) {
                socket.chatAuthorizedRooms.clear()
            }
            const apptId = socket.appointmentVideoRoom
            if (apptId && videoRooms.has(apptId)) {
                const roomParticipants = videoRooms.get(apptId)
                const participantData = roomParticipants.get(socket.id)
                const senderName = participantData ? participantData.name : 'Participant'
                roomParticipants.delete(socket.id)

                io.to(`video_${apptId}`).emit("peer_left", {
                    message: `${senderName} disconnected`
                })

                if (roomParticipants.size === 0) {
                    videoRooms.delete(apptId)
                }
            }
        } catch (err) {
            console.error("[video] Error during socket disconnect cleanup:", err.message)
        }
    })
})

connectDB()
connectCloudinary()
initReminderScheduler()

// middlewares
app.use(express.json({
    verify: (req, _res, buf) => {
        req.rawBody = buf
    }
}))
app.use(helmet())

app.use(cors({
    origin: (origin, callback) => {
        // allow requests with no origin (like mobile apps, postman, server-to-server) or during development
        if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
            return callback(null, true)
        }
        return callback(new Error('Blocked by CORS policy'))
    },
    credentials: true
}))

// api endpoints
app.use("/api/webhook", webhookRouter)
app.use("/api/user", userRouter)
app.use("/api/admin", adminRouter)
app.use("/api/doctor", doctorRouter)
app.use("/api/chat", chatRouter)
app.use("/api/video", videoRouter)
app.use("/api/recommendation", recommendationRouter)

app.get("/", (_req, res) => {
  res.send("API Working")
});

// Centralized error handling middleware
app.use((err, _req, res, _next) => {
    console.error("Internal Server Error:", err.message)
    const statusCode = err.statusCode || 500
    res.status(statusCode).json({
        success: false,
        message: err.message || "Internal Server Error"
    })
})

httpServer.listen(port, () => console.log(`Server started on PORT:${port}`))   