import jwt from "jsonwebtoken"
import appointmentModel from "../models/appointmentModel.js"
import { parseAppointmentSlot } from "../services/scheduler.js"

// Configurable consultation joining window
const WINDOW_BEFORE_MINUTES = parseInt(process.env.VIDEO_JOIN_WINDOW_BEFORE_MINUTES || '60', 10)
const WINDOW_AFTER_MINUTES = parseInt(process.env.VIDEO_JOIN_WINDOW_AFTER_MINUTES || '240', 10)

/**
 * Returns ICE servers configuration (STUN + optional TURN)
 */
export const getIceServers = () => {
    const stunServers = process.env.RTC_STUN_SERVER
        ? process.env.RTC_STUN_SERVER.split(',').map(s => s.trim())
        : [
            "stun:stun.l.google.com:19302",
            "stun:stun1.l.google.com:19302",
            "stun:stun2.l.google.com:19302"
        ]

    const iceServers = stunServers.map(url => ({ urls: url }))

    if (process.env.RTC_TURN_SERVER) {
        const turnUrls = process.env.RTC_TURN_SERVER.split(',').map(s => s.trim())
        const turnConfig = {
            urls: turnUrls
        }
        if (process.env.RTC_TURN_USERNAME) {
            turnConfig.username = process.env.RTC_TURN_USERNAME
        }
        if (process.env.RTC_TURN_CREDENTIAL) {
            turnConfig.credential = process.env.RTC_TURN_CREDENTIAL
        }
        iceServers.push(turnConfig)
    }

    return iceServers
}

/**
 * Validates joining eligibility (status, cancellation, completion, and joining window)
 */
const validateAppointmentEligibility = (appointment) => {
    if (appointment.cancelled) {
        return { eligible: false, statusCode: 400, message: "Cannot start video consultation for a cancelled appointment" }
    }
    if (appointment.isCompleted) {
        return { eligible: false, statusCode: 400, message: "Cannot join video consultation for a completed appointment" }
    }

    // Time window validation (can be bypassed for testing via VIDEO_DISABLE_TIME_CHECK=true)
    if (process.env.VIDEO_DISABLE_TIME_CHECK !== 'true') {
        const slotDate = appointment.slotDate
        const slotTime = appointment.slotTime
        const apptDate = parseAppointmentSlot(slotDate, slotTime)

        if (apptDate) {
            const now = Date.now()
            const apptTimestamp = apptDate.getTime()
            const earliestJoin = apptTimestamp - (WINDOW_BEFORE_MINUTES * 60 * 1000)
            const latestJoin = apptTimestamp + (WINDOW_AFTER_MINUTES * 60 * 1000)

            if (now < earliestJoin) {
                const minutesLeft = Math.ceil((earliestJoin - now) / (60 * 1000))
                return {
                    eligible: false,
                    statusCode: 400,
                    message: `Consultation window opens ${WINDOW_BEFORE_MINUTES} minutes before your slot (in approximately ${minutesLeft} minutes)`
                }
            }
            if (now > latestJoin) {
                return {
                    eligible: false,
                    statusCode: 400,
                    message: "The consultation window for this appointment has expired"
                }
            }
        }
    }

    return { eligible: true }
}

/**
 * Patient endpoint: generates authenticated video consultation token
 */
export const getPatientVideoToken = async (req, res) => {
    try {
        const { appointmentId } = req.body
        const authUserId = req.body.userId // Injected by verified authUser JWT middleware

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: "Appointment ID is required" })
        }
        if (!authUserId) {
            return res.status(401).json({ success: false, message: "Unauthorized access: patient authentication required" })
        }

        const appointment = await appointmentModel.findById(appointmentId)
        if (!appointment) {
            return res.status(404).json({ success: false, message: "Appointment not found" })
        }

        // Strict ownership check: verified JWT patient ID must match appointment.userId
        if (appointment.userId.toString() !== authUserId.toString()) {
            return res.status(403).json({ success: false, message: "Forbidden: You are not authorized to join this consultation" })
        }

        // Eligibility check (cancelled, completed, time window)
        const check = validateAppointmentEligibility(appointment)
        if (!check.eligible) {
            return res.status(check.statusCode).json({ success: false, message: check.message })
        }

        // Generate short-lived (1 hour) appointment-specific consultation token
        const participantName = appointment.userData?.name || "Patient"
        const sessionToken = jwt.sign(
            {
                appointmentId: appointment._id.toString(),
                participantId: authUserId.toString(),
                role: "patient",
                name: participantName,
                docId: appointment.docId.toString(),
                userId: appointment.userId.toString()
            },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        )

        res.json({
            success: true,
            sessionToken,
            appointmentId: appointment._id.toString(),
            role: "patient",
            participantName,
            peerName: `Dr. ${appointment.docData?.name || "Doctor"}`,
            iceServers: getIceServers()
        })
    } catch (error) {
        console.error("[videoController] Error in getPatientVideoToken:", error.message)
        res.status(500).json({ success: false, message: error.message })
    }
}

/**
 * Doctor endpoint: generates authenticated video consultation token
 */
export const getDoctorVideoToken = async (req, res) => {
    try {
        const { appointmentId } = req.body
        const authDocId = req.body.docId // Injected by verified authDoctor JWT middleware

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: "Appointment ID is required" })
        }
        if (!authDocId) {
            return res.status(401).json({ success: false, message: "Unauthorized access: doctor authentication required" })
        }

        const appointment = await appointmentModel.findById(appointmentId)
        if (!appointment) {
            return res.status(404).json({ success: false, message: "Appointment not found" })
        }

        // Strict ownership check: verified JWT doctor ID must match appointment.docId
        if (appointment.docId.toString() !== authDocId.toString()) {
            return res.status(403).json({ success: false, message: "Forbidden: You are not assigned to this appointment" })
        }

        // Eligibility check (cancelled, completed, time window)
        const check = validateAppointmentEligibility(appointment)
        if (!check.eligible) {
            return res.status(check.statusCode).json({ success: false, message: check.message })
        }

        // Generate short-lived (1 hour) appointment-specific consultation token
        const participantName = `Dr. ${appointment.docData?.name || "Doctor"}`
        const sessionToken = jwt.sign(
            {
                appointmentId: appointment._id.toString(),
                participantId: authDocId.toString(),
                role: "doctor",
                name: participantName,
                docId: appointment.docId.toString(),
                userId: appointment.userId.toString()
            },
            process.env.JWT_SECRET,
            { expiresIn: "1h" }
        )

        res.json({
            success: true,
            sessionToken,
            appointmentId: appointment._id.toString(),
            role: "doctor",
            participantName,
            peerName: appointment.userData?.name || "Patient",
            iceServers: getIceServers()
        })
    } catch (error) {
        console.error("[videoController] Error in getDoctorVideoToken:", error.message)
        res.status(500).json({ success: false, message: error.message })
    }
}

export default {
    getPatientVideoToken,
    getDoctorVideoToken,
    getIceServers
}
