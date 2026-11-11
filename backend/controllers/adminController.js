import jwt from "jsonwebtoken";
import appointmentModel from "../models/appointmentModel.js";
import doctorModel from "../models/doctorModel.js";
import bcrypt from "bcrypt";
import validator from "validator";
import { v2 as cloudinary } from "cloudinary";
import userModel from "../models/userModel.js";
import { sendAppointmentReminderEmail, sendAppointmentCancellationEmail } from "../config/mailer.js";
import { checkAndSendReminders } from "../services/scheduler.js";
import { processRefund } from "../services/refundService.js";

// API for admin login
const loginAdmin = async (req, res) => {
    try {

        const { email, password } = req.body

        // If ADMIN_PASSWORD_HASH is set, verify using bcrypt (recommended).
        // Falls back to plain-text ADMIN_PASSWORD comparison for backward compatibility.
        let isValidPassword = false
        if (process.env.ADMIN_PASSWORD_HASH) {
            isValidPassword = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH)
        } else {
            isValidPassword = password === process.env.ADMIN_PASSWORD
        }

        if (email === process.env.ADMIN_EMAIL && isValidPassword) {
            const token = jwt.sign({ email, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1d' })
            res.json({ success: true, token })
        } else {
            res.json({ success: false, message: "Invalid credentials" })
        }

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}


// API to get all appointments list
const appointmentsAdmin = async (req, res) => {
    try {

        const appointments = await appointmentModel.find({})
        res.json({ success: true, appointments })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}

// API for appointment cancellation by admin
const appointmentCancel = async (req, res) => {
    try {
        const { appointmentId } = req.body

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: 'Missing appointment ID' })
        }

        const appointmentData = await appointmentModel.findById(appointmentId)
        if (!appointmentData) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        if (appointmentData.isCompleted) {
            return res.status(400).json({ success: false, message: 'Cannot cancel an already completed appointment' })
        }

        if (appointmentData.cancelled) {
            return res.status(400).json({ success: false, message: 'Appointment is already cancelled' })
        }

        const isEligibleRefund = Boolean(
            appointmentData.payment &&
            !appointmentData.isCash &&
            appointmentData.paymentMode !== 'cash' &&
            appointmentData.paymentMethod !== 'cash'
        )

        // Atomic conditional cancellation: prevents concurrent duplicate cancellations
        const cancelledAppointment = await appointmentModel.findOneAndUpdate(
            {
                _id: appointmentId,
                cancelled: false,
                isCompleted: { $ne: true }
            },
            {
                $set: {
                    cancelled: true,
                    ...(!isEligibleRefund ? { refundStatus: 'not_applicable' } : {})
                }
            },
            { new: true }
        )

        if (!cancelledAppointment) {
            const current = await appointmentModel.findById(appointmentId)
            if (current?.isCompleted) {
                return res.status(400).json({ success: false, message: 'Cannot cancel an already completed appointment' })
            }
            return res.status(400).json({ success: false, message: 'Appointment is already cancelled' })
        }

        // Release doctor slot
        const { docId, slotDate, slotTime } = appointmentData
        const doctorData = await doctorModel.findById(docId)
        if (doctorData && doctorData.slots_booked && doctorData.slots_booked[slotDate]) {
            let slots_booked = doctorData.slots_booked
            slots_booked[slotDate] = slots_booked[slotDate].filter(e => e !== slotTime)
            await doctorModel.findByIdAndUpdate(docId, { slots_booked })
        }

        // Trigger isolated dedicated refund service for eligible online payments
        let refundResult = null
        if (isEligibleRefund) {
            try {
                refundResult = await processRefund(appointmentId)
            } catch (refundErr) {
                console.error('[admin appointmentCancel] Refund processing error:', refundErr.message)
                refundResult = { success: false, status: 'failed', error: refundErr.message }
            }
        }

        // Determine accurate status-specific messaging
        let refundNote = ''
        let responseMessage = 'Appointment Cancelled'
        let finalRefundStatus = isEligibleRefund ? 'failed' : 'not_applicable'

        if (isEligibleRefund && refundResult) {
            if (refundResult.status === 'refunded') {
                refundNote = 'Fee has been refunded successfully.'
                responseMessage = 'Appointment Cancelled. Fee refund successfully processed.'
                finalRefundStatus = 'refunded'
            } else if (refundResult.status === 'pending') {
                refundNote = 'Fee refund has been initiated and is pending provider settlement.'
                responseMessage = 'Appointment Cancelled. Fee refund is pending provider settlement.'
                finalRefundStatus = 'pending'
            } else if (refundResult.status === 'ambiguous_timeout' || refundResult.status === 'temporary_outage') {
                refundNote = 'Fee refund request is pending verification with the payment provider.'
                responseMessage = 'Appointment Cancelled. Fee refund is pending provider reconciliation.'
                finalRefundStatus = 'pending'
            } else {
                refundNote = 'Automated refund could not be processed. Our administrative team will review and process your refund manually.'
                responseMessage = 'Appointment Cancelled. Automated fee refund failed and has been flagged for manual review.'
                finalRefundStatus = 'failed'
            }
        }

        // Task 3: Notify patient of admin cancellation (non-blocking)
        sendAppointmentCancellationEmail({
            to: appointmentData.userData?.email,
            recipientName: appointmentData.userData?.name,
            userName: appointmentData.userData?.name,
            docName: doctorData?.name || appointmentData.docData?.name,
            slotDate,
            slotTime,
            cancelledBy: 'Clinic Administration',
            refundInfo: refundNote
        }).catch(err => console.log('[mailer] Admin cancellation email to patient error:', err.message))

        // Task 3: Notify doctor of admin cancellation (non-blocking)
        if (doctorData?.email) {
            sendAppointmentCancellationEmail({
                to: doctorData.email,
                recipientName: `Dr. ${doctorData.name}`,
                userName: appointmentData.userData?.name,
                docName: doctorData.name,
                slotDate,
                slotTime,
                cancelledBy: 'Clinic Administration'
            }).catch(err => console.log('[mailer] Admin cancellation email to doctor error:', err.message))
        }

        return res.json({
            success: true,
            message: responseMessage,
            refundStatus: finalRefundStatus,
            ...(refundResult?.refundId ? { refundId: refundResult.refundId } : {})
        })

    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API for adding Doctor
const addDoctor = async (req, res) => {

    try {

        const { name, email, password, speciality, degree, experience, about, fees, address } = req.body
        const imageFile = req.file

        // checking for all data to add doctor including image
        if (!imageFile || !name || !email || !password || !speciality || !degree || !experience || !about || !fees || !address) {
            return res.status(400).json({ success: false, message: "Missing Details or Doctor Image" })
        }

        // validating email format
        if (!validator.isEmail(email)) {
            return res.json({ success: false, message: "Please enter a valid email" })
        }

        // validating strong password
        if (password.length < 8) {
            return res.json({ success: false, message: "Please enter a strong password" })
        }

        // hashing user password
        const salt = await bcrypt.genSalt(10); // the more no. round the more time it will take
        const hashedPassword = await bcrypt.hash(password, salt)

        // upload image to cloudinary
        const imageUpload = await cloudinary.uploader.upload(imageFile.path, { resource_type: "image" })
        const imageUrl = imageUpload.secure_url

        const doctorData = {
            name,
            email,
            image: imageUrl,
            password: hashedPassword,
            speciality,
            degree,
            experience,
            about,
            fees,
            address: JSON.parse(address),
            isApproved: true,
            date: Date.now()
        }

        const newDoctor = new doctorModel(doctorData)
        await newDoctor.save()
        res.json({ success: true, message: 'Doctor Added' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get all doctors list for admin panel
const allDoctors = async (req, res) => {
    try {

        const doctors = await doctorModel.find({}).select('-password')
        res.json({ success: true, doctors })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get dashboard data for admin panel
const adminDashboard = async (req, res) => {
    try {

        const doctors = await doctorModel.find({})
        const users = await userModel.find({})
        const appointments = await appointmentModel.find({})

        const dashData = {
            doctors: doctors.length,
            appointments: appointments.length,
            patients: users.length,
            latestAppointments: appointments.reverse()
        }

        res.json({ success: true, dashData })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to trigger upcoming appointment email reminders
const sendReminders = async (_req, res) => {
    try {
        const result = await checkAndSendReminders()
        if (result.error) {
            return res.status(500).json({ success: false, message: result.error })
        }

        res.json({
            success: true,
            message: `Reminders processed: ${result.reminders24hSent} 24-hr reminder(s), ${result.reminders1hSent} 1-hr reminder(s) sent out of ${result.totalEvaluated} upcoming appointments evaluated.`
        })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to get all registered patients for admin
const allUsers = async (_req, res) => {
    try {
        const users = await userModel.find({}).select('-password')
        res.json({ success: true, users })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to toggle block status of a user
const toggleBlockUser = async (req, res) => {
    try {
        const { userId } = req.body
        const user = await userModel.findById(userId)
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' })
        }
        await userModel.findByIdAndUpdate(userId, { isBlocked: !user.isBlocked })
        res.json({ success: true, message: user.isBlocked ? 'User unblocked successfully' : 'User blocked successfully' })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to delete a doctor
const deleteDoctor = async (req, res) => {
    try {
        const { docId } = req.body
        if (!docId) {
            return res.status(400).json({ success: false, message: 'Doctor ID is required' })
        }

        const doctor = await doctorModel.findById(docId)
        if (!doctor) {
            return res.status(404).json({ success: false, message: 'Doctor not found' })
        }

        // Prevent deleting doctor if there are active, upcoming scheduled appointments
        const activeAppointments = await appointmentModel.countDocuments({
            docId,
            cancelled: false,
            isCompleted: false
        })
        if (activeAppointments > 0) {
            return res.status(400).json({
                success: false,
                message: `Cannot delete doctor with ${activeAppointments} active upcoming appointment(s). Please cancel or reassign them first.`
            })
        }

        await doctorModel.findByIdAndDelete(docId)
        res.json({ success: true, message: 'Doctor deleted successfully' })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to approve or revoke approval of a doctor
const approveDoctor = async (req, res) => {
    try {
        const { docId, isApproved } = req.body
        if (!docId) {
            return res.status(400).json({ success: false, message: 'Doctor ID is required' })
        }
        const doctor = await doctorModel.findById(docId)
        if (!doctor) {
            return res.status(404).json({ success: false, message: 'Doctor not found' })
        }
        const newApprovalStatus = typeof isApproved === 'boolean' ? isApproved : !doctor.isApproved
        await doctorModel.findByIdAndUpdate(docId, { isApproved: newApprovalStatus })
        res.json({
            success: true,
            message: newApprovalStatus ? 'Doctor approved successfully' : 'Doctor approval revoked successfully',
            isApproved: newApprovalStatus
        })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

export {
    loginAdmin,
    appointmentsAdmin,
    appointmentCancel,
    addDoctor,
    allDoctors,
    adminDashboard,
    sendReminders,
    allUsers,
    toggleBlockUser,
    deleteDoctor,
    approveDoctor
}