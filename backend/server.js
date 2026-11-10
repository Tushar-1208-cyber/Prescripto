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
import messageModel from "./models/messageModel.js"
import { initReminderScheduler } from "./services/scheduler.js"

// app config
const app = express()
const port = process.env.PORT || 4000
const httpServer = http.createServer(app)

// Real-time Socket.io server
const io = new SocketIOServer(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
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

io.on("connection", (socket) => {
    // Existing text chat handlers
    socket.on("join_room", (appointmentId) => {
        socket.join(`room_${appointmentId}`)
    })

    socket.on("send_message", async (data) => {
        try {
            const { appointmentId, senderId, senderName, senderRole, message } = data
            if (appointmentId && message) {
                const newMessage = new messageModel({
                    appointmentId,
                    senderId,
                    senderName,
                    senderRole,
                    message,
                    timestamp: Date.now()
                })
                await newMessage.save()
                io.to(`room_${appointmentId}`).emit("receive_message", newMessage)
            }
        } catch (error) {
            console.error("Socket error on send_message:", error.message)
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
app.use(express.json())
app.use(helmet())

// CORS configuration supporting development and configurable production origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000']

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
app.use("/api/user", userRouter)
app.use("/api/admin", adminRouter)
app.use("/api/doctor", doctorRouter)
app.use("/api/chat", chatRouter)
app.use("/api/video", videoRouter)

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