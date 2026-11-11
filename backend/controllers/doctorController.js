import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import doctorModel from "../models/doctorModel.js";
import appointmentModel from "../models/appointmentModel.js";
import reviewModel from "../models/reviewModel.js";
import { sendAppointmentCancellationEmail } from "../config/mailer.js";
import { processRefund } from "../services/refundService.js";

// API for self doctor registration
const registerDoctor = async (req, res) => {
    try {
        const { name, email, password, speciality, degree, experience, about, fees, address } = req.body
        const imageFile = req.file

        if (!name || !email || !password || !speciality || !degree || !experience || !about || !fees) {
            return res.status(400).json({ success: false, message: 'Please fill all required details' })
        }

        const existingDoc = await doctorModel.findOne({ email })
        if (existingDoc) {
            return res.status(409).json({ success: false, message: 'Doctor already exists with this email' })
        }

        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(password, salt)

        let imageUrl = 'https://via.placeholder.com/150'
        if (imageFile) {
            const cloudinaryModule = await import('cloudinary')
            const cloudinary = cloudinaryModule.v2
            const imageUpload = await cloudinary.uploader.upload(imageFile.path, { resource_type: "image" })
            imageUrl = imageUpload.secure_url
        }

        const parsedAddress = typeof address === 'string' ? JSON.parse(address || '{}') : (address || {})

        const doctorData = {
            name,
            email,
            password: hashedPassword,
            image: imageUrl,
            speciality,
            degree,
            experience,
            about,
            fees: Number(fees),
            address: parsedAddress,
            isApproved: false,
            date: Date.now()
        }

        const newDoc = new doctorModel(doctorData)
        await newDoc.save()

        res.status(201).json({
            success: true,
            message: 'Doctor registered successfully. Account is pending administrator approval.',
            isApproved: false
        })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API for doctor Login 
const loginDoctor = async (req, res) => {

    try {

        const { email, password } = req.body
        const user = await doctorModel.findOne({ email })

        if (!user) {
            return res.status(401).json({ success: false, message: "Invalid credentials" })
        }

        const isMatch = await bcrypt.compare(password, user.password)

        if (!isMatch) {
            return res.status(401).json({ success: false, message: "Invalid credentials" })
        }

        if (user.isApproved === false) {
            return res.status(403).json({
                success: false,
                message: "Your account is pending administrator approval. Please contact support."
            })
        }

        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' })
        res.json({ success: true, token })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get doctor appointments for doctor panel
const appointmentsDoctor = async (req, res) => {
    try {

        const { docId } = req.body
        const appointments = await appointmentModel.find({ docId })

        res.json({ success: true, appointments })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to cancel appointment for doctor panel
const appointmentCancel = async (req, res) => {
    try {
        const { docId, appointmentId } = req.body

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: 'Missing appointment ID' })
        }

        const appointmentData = await appointmentModel.findById(appointmentId)
        if (!appointmentData) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        // Verify doctor ownership
        if (appointmentData.docId.toString() !== docId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
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
                docId: docId.toString(),
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
        const { slotDate, slotTime } = appointmentData
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
                console.error('[doctor appointmentCancel] Refund processing error:', refundErr.message)
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

        // Send non-blocking cancellation email to patient
        sendAppointmentCancellationEmail({
            to: appointmentData.userData?.email,
            recipientName: appointmentData.userData?.name,
            userName: appointmentData.userData?.name,
            docName: doctorData?.name || appointmentData.docData?.name,
            slotDate,
            slotTime,
            cancelledBy: `Dr. ${doctorData?.name || appointmentData.docData?.name || 'Doctor'}`,
            refundInfo: refundNote
        }).catch(err => console.log('[mailer] Doctor-cancellation email error:', err.message))

        // Also notify doctor confirmation
        if (doctorData?.email) {
            sendAppointmentCancellationEmail({
                to: doctorData.email,
                recipientName: `Dr. ${doctorData.name}`,
                userName: appointmentData.userData?.name,
                docName: doctorData.name,
                slotDate,
                slotTime,
                cancelledBy: 'Doctor'
            }).catch(err => console.log('[mailer] Doctor confirmation cancellation email error:', err.message))
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

// API to mark appointment completed for doctor panel
const appointmentComplete = async (req, res) => {
    try {

        const { docId, appointmentId } = req.body

        const appointmentData = await appointmentModel.findById(appointmentId)
        if (appointmentData && appointmentData.docId === docId) {
            await appointmentModel.findByIdAndUpdate(appointmentId, { isCompleted: true })
            return res.json({ success: true, message: 'Appointment Completed' })
        }

        res.json({ success: false, message: 'Appointment Cancelled' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}

// API to get all doctors list for Frontend
const doctorList = async (req, res) => {
    try {

        const doctors = await doctorModel.find({ isApproved: { $ne: false } }).select(['-password', '-email'])
        res.json({ success: true, doctors })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}

// API to change doctor availablity for Admin and Doctor Panel
const changeAvailablity = async (req, res) => {
    try {

        const { docId } = req.body

        const docData = await doctorModel.findById(docId)
        await doctorModel.findByIdAndUpdate(docId, { available: !docData.available })
        res.json({ success: true, message: 'Availablity Changed' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get doctor profile for  Doctor Panel
const doctorProfile = async (req, res) => {
    try {

        const { docId } = req.body
        const profileData = await doctorModel.findById(docId).select('-password')

        res.json({ success: true, profileData })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to update doctor profile data from Doctor Panel
const updateDoctorProfile = async (req, res) => {
    try {
        const { docId, fees, address, available, workingHours, daysOff } = req.body

        const updateData = { fees, address, available }
        if (workingHours) updateData.workingHours = workingHours
        if (daysOff) updateData.daysOff = daysOff

        await doctorModel.findByIdAndUpdate(docId, updateData)
        res.json({ success: true, message: 'Profile Updated' })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to get dashboard data for doctor panel
const doctorDashboard = async (req, res) => {
    try {

        const { docId } = req.body

        const appointments = await appointmentModel.find({ docId })

        let earnings = 0

        appointments.map((item) => {
            if (item.isCompleted || item.payment) {
                earnings += item.amount
            }
        })

        let patients = []

        appointments.map((item) => {
            if (!patients.includes(item.userId)) {
                patients.push(item.userId)
            }
        })



        const dashData = {
            earnings,
            appointments: appointments.length,
            patients: patients.length,
            latestAppointments: appointments.reverse()
        }

        res.json({ success: true, dashData })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to get all reviews for a doctor (public)
const getDoctorReviews = async (req, res) => {
    try {

        const { docId } = req.params
        const reviews = await reviewModel.find({ docId }).sort({ date: -1 })

        res.json({ success: true, reviews })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to add or update digital prescription for an appointment
const addPrescription = async (req, res) => {
    try {
        const { docId, appointmentId, diagnosis, notes, medicines } = req.body

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: 'Appointment ID is required' })
        }

        const appointment = await appointmentModel.findById(appointmentId)
        if (!appointment) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        if (appointment.docId.toString() !== docId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
        }

        const prescriptionData = {
            diagnosis: diagnosis || '',
            notes: notes || '',
            medicines: medicines || [],
            dateIssued: Date.now()
        }

        await appointmentModel.findByIdAndUpdate(appointmentId, {
            prescription: prescriptionData,
            isCompleted: true
        })

        res.json({ success: true, message: 'Prescription saved successfully' })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

export {
    registerDoctor,
    loginDoctor,
    appointmentsDoctor,
    appointmentCancel,
    doctorList,
    changeAvailablity,
    appointmentComplete,
    doctorDashboard,
    doctorProfile,
    updateDoctorProfile,
    getDoctorReviews,
    addPrescription
}