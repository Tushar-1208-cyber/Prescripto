import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import validator from "validator";
import crypto from "crypto";
import userModel from "../models/userModel.js";
import doctorModel from "../models/doctorModel.js";
import appointmentModel from "../models/appointmentModel.js";
import reviewModel from "../models/reviewModel.js";
import { v2 as cloudinary } from 'cloudinary'
import stripe from "stripe";
import razorpay from 'razorpay';
import {
    sendRegistrationWelcomeEmail,
    sendAppointmentConfirmationEmail,
    sendDoctorBookingNotificationEmail,
    sendAppointmentCancellationEmail,
    sendPaymentReceiptEmail,
    sendPasswordResetOtpEmail
} from "../config/mailer.js";
import { processRefund } from "../services/refundService.js";

// Gateway Initialize
const stripeInstance = new stripe(process.env.STRIPE_SECRET_KEY)
const razorpayInstance = new razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
})

// API to register user
const registerUser = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // checking for all data to register user
        if (!name || !email || !password) {
            return res.status(400).json({ success: false, message: 'Missing Details' })
        }

        // validating email format
        if (!validator.isEmail(email)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email" })
        }

        // validating strong password
        if (password.length < 8) {
            return res.status(400).json({ success: false, message: "Please enter a strong password (minimum 8 characters)" })
        }

        // check if user already exists
        const existingUser = await userModel.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ success: false, message: "User already exists with this email" })
        }

        // hashing user password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt)

        const userData = {
            name,
            email,
            password: hashedPassword,
        }

        const newUser = new userModel(userData)
        const user = await newUser.save()
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' })

        // Task 1: Welcome email after registration (non-blocking)
        sendRegistrationWelcomeEmail({
            to: user.email,
            userName: user.name
        }).catch(err => console.log('[mailer] Non-blocking welcome email error:', err.message))

        res.status(201).json({ success: true, token })

    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to login user
const loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password are required" })
        }

        const user = await userModel.findOne({ email })
        if (!user) {
            return res.status(401).json({ success: false, message: "Invalid credentials" })
        }

        if (user.isBlocked) {
            return res.status(403).json({ success: false, message: "Your account has been suspended. Please contact support." })
        }

        const isMatch = await bcrypt.compare(password, user.password)
        if (isMatch) {
            const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '7d' })
            res.json({ success: true, token })
        } else {
            res.status(401).json({ success: false, message: "Invalid credentials" })
        }
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to get user profile data
const getProfile = async (req, res) => {
    try {
        const { userId } = req.body
        const userData = await userModel.findById(userId).select('-password')
        if (!userData) {
            return res.status(404).json({ success: false, message: "User not found" })
        }

        res.json({ success: true, userData })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to update user profile
const updateProfile = async (req, res) => {

    try {

        const { userId, name, phone, address, dob, gender } = req.body
        const imageFile = req.file

        if (!name || !phone || !dob || !gender) {
            return res.json({ success: false, message: "Data Missing" })
        }

        await userModel.findByIdAndUpdate(userId, { name, phone, address: JSON.parse(address), dob, gender })

        if (imageFile) {

            // upload image to cloudinary
            const imageUpload = await cloudinary.uploader.upload(imageFile.path, { resource_type: "image" })
            const imageURL = imageUpload.secure_url

            await userModel.findByIdAndUpdate(userId, { image: imageURL })
        }

        res.json({ success: true, message: 'Profile Updated' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to book appointment 
const bookAppointment = async (req, res) => {
    try {
        const { userId, docId, slotDate, slotTime, paymentMode, isCash } = req.body

        if (!docId || !slotDate || !slotTime) {
            return res.status(400).json({ success: false, message: 'Missing appointment details' })
        }

        const docData = await doctorModel.findById(docId).select("-password")
        if (!docData) {
            return res.status(404).json({ success: false, message: 'Doctor not found' })
        }

        if (docData.isApproved === false) {
            return res.status(400).json({ success: false, message: 'Doctor is not approved for bookings' })
        }

        if (!docData.available) {
            return res.status(400).json({ success: false, message: 'Doctor is currently not available' })
        }

        let slots_booked = docData.slots_booked || {}

        // Checking for slot availability in memory
        if (slots_booked[slotDate] && slots_booked[slotDate].includes(slotTime)) {
            return res.status(409).json({ success: false, message: 'Slot Not Available' })
        }

        const userData = await userModel.findById(userId).select("-password")
        if (!userData) {
            return res.status(404).json({ success: false, message: 'User not found' })
        }

        const isCashAppointment = paymentMode === 'cash' || isCash === true

        const appointmentData = {
            userId,
            docId,
            userData,
            docData: {
                name: docData.name,
                image: docData.image,
                speciality: docData.speciality,
                degree: docData.degree,
                experience: docData.experience,
                fees: docData.fees,
                address: docData.address
            },
            amount: docData.fees,
            slotTime,
            slotDate,
            date: Date.now(),
            payment: false,
            paymentMode: isCashAppointment ? 'cash' : 'online',
            isCash: isCashAppointment,
            paymentMethod: isCashAppointment ? 'cash' : null
        }

        // Creating appointment: partial unique index protects against concurrent double-booking
        const newAppointment = new appointmentModel(appointmentData)
        await newAppointment.save()

        // Update slots_booked in doctor record
        if (!slots_booked[slotDate]) {
            slots_booked[slotDate] = []
        }
        slots_booked[slotDate].push(slotTime)
        await doctorModel.findByIdAndUpdate(docId, { slots_booked })

        // Task 2: Send confirmation email to patient (non-blocking)
        sendAppointmentConfirmationEmail({
            to: userData.email,
            userName: userData.name,
            docName: docData.name,
            slotDate,
            slotTime
        }).catch(err => console.log('[mailer] Non-blocking patient confirmation email error:', err.message))

        // Task 2: Send booking notification to doctor (non-blocking)
        if (docData.email) {
            sendDoctorBookingNotificationEmail({
                to: docData.email,
                docName: docData.name,
                userName: userData.name,
                slotDate,
                slotTime,
                amount: docData.fees
            }).catch(err => console.log('[mailer] Non-blocking doctor booking email error:', err.message))
        }

        res.status(201).json({ success: true, message: 'Appointment Booked' })

    } catch (error) {
        console.log(error)
        if (error.code === 11000) {
            return res.status(409).json({ success: false, message: 'This slot has already been booked. Please choose another time.' })
        }
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to cancel appointment
const cancelAppointment = async (req, res) => {
    try {
        const { userId, appointmentId } = req.body

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: 'Missing appointment ID' })
        }

        const appointmentData = await appointmentModel.findById(appointmentId)
        if (!appointmentData) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        // verify appointment user 
        if (appointmentData.userId.toString() !== userId.toString()) {
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
                userId: userId.toString(),
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

        // releasing doctor slot 
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
                console.error('[cancelAppointment] Refund processing error:', refundErr.message)
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

        // Task 3: Send cancellation email to patient (non-blocking)
        sendAppointmentCancellationEmail({
            to: appointmentData.userData?.email,
            recipientName: appointmentData.userData?.name,
            userName: appointmentData.userData?.name,
            docName: appointmentData.docData?.name,
            slotDate,
            slotTime,
            cancelledBy: 'Patient',
            refundInfo: refundNote
        }).catch(err => console.log('[mailer] Non-blocking patient cancellation email error:', err.message))

        // Task 3: Send cancellation notification to doctor (non-blocking)
        if (doctorData?.email) {
            sendAppointmentCancellationEmail({
                to: doctorData.email,
                recipientName: `Dr. ${doctorData.name}`,
                userName: appointmentData.userData?.name,
                docName: doctorData.name,
                slotDate,
                slotTime,
                cancelledBy: 'Patient'
            }).catch(err => console.log('[mailer] Non-blocking doctor cancellation email error:', err.message))
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

// API to get user appointments for frontend my-appointments page
const listAppointment = async (req, res) => {
    try {

        const { userId } = req.body
        const appointments = await appointmentModel.find({ userId })

        res.json({ success: true, appointments })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to make payment of appointment using razorpay
const paymentRazorpay = async (req, res) => {
    try {
        const { appointmentId, userId } = req.body
        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        if (appointmentData.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
        }

        if (appointmentData.cancelled) {
            return res.status(400).json({ success: false, message: 'Appointment is cancelled' })
        }

        if (appointmentData.payment) {
            return res.status(400).json({ success: false, message: 'Appointment already paid' })
        }

        // creating options for razorpay payment
        const options = {
            amount: appointmentData.amount * 100,
            currency: process.env.CURRENCY || 'INR',
            receipt: appointmentId,
        }

        // creation of an order
        const order = await razorpayInstance.orders.create(options)

        // Persist generated orderId to the appointment record (Phase 4 Task 4.1)
        await appointmentModel.findByIdAndUpdate(appointmentId, { orderId: order.id })

        res.json({ success: true, order })

    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to verify payment of razorpay with HMAC signature and ownership check
const verifyRazorpay = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId } = req.body

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Order ID, payment ID, and signature are required' })
        }

        const orderInfo = await razorpayInstance.orders.fetch(razorpay_order_id)
        if (!orderInfo || !orderInfo.receipt) {
            return res.status(404).json({ success: false, message: 'Order not found' })
        }

        const appointment = await appointmentModel.findById(orderInfo.receipt)
        if (!appointment) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        // verify ownership
        if (appointment.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
        }

        if (appointment.cancelled) {
            return res.status(400).json({ success: false, message: 'Appointment is cancelled' })
        }

        // Confirm payment belongs to expected order for this appointment
        if (appointment.orderId && appointment.orderId !== razorpay_order_id) {
            return res.status(400).json({ success: false, message: 'Order ID mismatch for this appointment' })
        }

        // Cryptographic signature validation
        if (!process.env.RAZORPAY_KEY_SECRET) {
            return res.status(500).json({ success: false, message: 'Razorpay secret key not configured' })
        }
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest('hex')

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, message: 'Invalid payment signature' })
        }

        // Fetch payment details from Razorpay to verify capture status and order binding
        let paymentInfo
        try {
            paymentInfo = await razorpayInstance.payments.fetch(razorpay_payment_id)
        } catch (fetchErr) {
            console.error('[verifyRazorpay] Payment fetch error:', fetchErr.message)
            return res.status(400).json({ success: false, message: 'Unable to verify payment status with gateway' })
        }

        if (!paymentInfo) {
            return res.status(400).json({ success: false, message: 'Payment record not found on Razorpay' })
        }

        // Confirm payment is linked to the expected order
        if (paymentInfo.order_id && paymentInfo.order_id !== razorpay_order_id) {
            return res.status(400).json({ success: false, message: 'Payment does not belong to the expected order' })
        }

        // Verify status is captured/paid
        if (paymentInfo.status !== 'captured' && orderInfo.status !== 'paid') {
            return res.status(400).json({ success: false, message: 'Payment is not captured or completed' })
        }

        // Validate amount and currency
        const expectedCurrency = (process.env.CURRENCY || 'INR').toUpperCase()
        const expectedAmountMinor = Math.round(Number(appointment.amount) * 100)

        const orderCurrency = (orderInfo.currency || '').toUpperCase()
        const paymentCurrency = (paymentInfo.currency || orderCurrency).toUpperCase()

        if (paymentCurrency !== expectedCurrency) {
            return res.status(400).json({ success: false, message: 'Payment currency mismatch' })
        }

        const verifiedAmount = paymentInfo.amount || orderInfo.amount_paid || orderInfo.amount
        if (verifiedAmount !== expectedAmountMinor) {
            return res.status(400).json({ success: false, message: 'Payment amount mismatch' })
        }

        // Idempotency: if already paid with this exact paymentId
        if (appointment.payment === true) {
            if (appointment.paymentId === razorpay_payment_id) {
                return res.json({ success: true, message: 'Payment already verified' })
            }
            if (appointment.paymentId && appointment.paymentId !== razorpay_payment_id) {
                return res.status(409).json({ success: false, message: 'Conflicting payment detected for this appointment' })
            }
        }

        // Atomic update: ensure appointment is marked paid only once and prevent conflicting payments
        const capturedAt = paymentInfo.created_at ? new Date(paymentInfo.created_at * 1000) : new Date()

        const updatedAppointment = await appointmentModel.findOneAndUpdate(
            {
                _id: appointment._id,
                $or: [
                    { payment: { $ne: true } },
                    { paymentId: razorpay_payment_id }
                ]
            },
            {
                $set: {
                    payment: true,
                    paymentMethod: 'razorpay',
                    paymentId: razorpay_payment_id,
                    orderId: razorpay_order_id,
                    paymentCurrency: paymentCurrency,
                    paymentAmountMinor: verifiedAmount,
                    paymentCapturedAt: capturedAt
                }
            },
            { new: true }
        )

        if (!updatedAppointment) {
            return res.status(409).json({ success: false, message: 'Conflicting payment detected for this appointment' })
        }

        // Safe claim pattern: transitions pending/failed or stale-sending to sending
            const STALE_TIMEOUT_MS = 5 * 60 * 1000
            const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MS)

            const claimed = await appointmentModel.findOneAndUpdate(
                {
                    _id: orderInfo.receipt,
                    receiptStatus: { $ne: 'sent' },
                    receiptSent: { $ne: true },
                    $or: [
                        { receiptStatus: { $in: ['pending', 'failed'] } },
                        { receiptStatus: 'sending', receiptClaimedAt: { $lt: staleThreshold } },
                        { receiptClaimedAt: null },
                        { receiptClaimedAt: { $exists: false } }
                    ]
                },
                {
                    $set: {
                        receiptStatus: 'sending',
                        receiptClaimedAt: new Date()
                    }
                },
                { new: true }
            )

            // Task 4: Payment Receipt email (atomic delivery verification, non-blocking)
            if (claimed && appointment.userData?.email) {
                sendPaymentReceiptEmail({
                    to: appointment.userData.email,
                    userName: appointment.userData.name,
                    docName: appointment.docData?.name || 'Doctor',
                    slotDate: appointment.slotDate,
                    slotTime: appointment.slotTime,
                    amount: appointment.amount,
                    paymentMethod: 'Razorpay',
                    transactionId: razorpay_payment_id || razorpay_order_id
                }).then(async (mailResult) => {
                    if (mailResult && mailResult.sent) {
                        await appointmentModel.findByIdAndUpdate(orderInfo.receipt, {
                            $set: {
                                receiptStatus: 'sent',
                                receiptSent: true,
                                receiptClaimedAt: null
                            }
                        })
                    } else {
                        console.log(`[mailer] Razorpay receipt delivery failed or unconfigured for ${orderInfo.receipt}. Releasing claim for retry.`)
                        await appointmentModel.findByIdAndUpdate(orderInfo.receipt, {
                            $set: {
                                receiptStatus: 'failed',
                                receiptClaimedAt: null
                            }
                        })
                    }
                }).catch(async (err) => {
                    console.log('[mailer] Error sending Razorpay receipt:', err.message)
                    await appointmentModel.findByIdAndUpdate(orderInfo.receipt, {
                        $set: {
                            receiptStatus: 'failed',
                            receiptClaimedAt: null
                        }
                    })
                })
            }

            res.json({ success: true, message: "Payment Successful" })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to make payment of appointment using Stripe
const paymentStripe = async (req, res) => {
    try {
        const { appointmentId, userId } = req.body
        const { origin } = req.headers

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        if (appointmentData.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
        }

        if (appointmentData.cancelled) {
            return res.status(400).json({ success: false, message: 'Appointment is cancelled' })
        }

        if (appointmentData.payment) {
            return res.status(400).json({ success: false, message: 'Appointment already paid' })
        }

        const currency = (process.env.CURRENCY || 'inr').toLowerCase()

        const line_items = [{
            price_data: {
                currency,
                product_data: {
                    name: `Doctor Consultation - ${appointmentData.docData?.name || 'Appointment'}`
                },
                unit_amount: appointmentData.amount * 100
            },
            quantity: 1
        }]

        const session = await stripeInstance.checkout.sessions.create({
            success_url: `${origin}/verify?success=true&appointmentId=${appointmentData._id}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/verify?success=false&appointmentId=${appointmentData._id}`,
            line_items: line_items,
            mode: 'payment',
            metadata: {
                appointmentId: appointmentData._id.toString(),
                userId: userId.toString()
            }
        })

        // Persist Checkout session ID against the appointment record (Phase 4 Task 4.1)
        await appointmentModel.findByIdAndUpdate(appointmentId, {
            checkoutSessionId: session.id,
            orderId: session.id
        })

        res.json({ success: true, session_url: session.url })

    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to verify Stripe payment server-side
const verifyStripe = async (req, res) => {
    try {
        const { appointmentId, session_id, userId } = req.body

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: 'Appointment ID required' })
        }

        if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
            return res.status(400).json({ success: false, message: 'Valid Stripe session ID is required' })
        }

        const appointmentData = await appointmentModel.findById(appointmentId)
        if (!appointmentData) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        if (appointmentData.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
        }

        if (appointmentData.cancelled) {
            return res.status(400).json({ success: false, message: 'Appointment is cancelled' })
        }

        // Validate session ID if recorded on appointment
        if (appointmentData.checkoutSessionId && appointmentData.checkoutSessionId !== session_id.trim()) {
            return res.status(400).json({ success: false, message: 'Stripe session ID does not match this appointment' })
        }

        // Server-side verification directly via Stripe API with payment_intent expanded
        let session
        try {
            session = await stripeInstance.checkout.sessions.retrieve(session_id.trim(), {
                expand: ['payment_intent']
            })
        } catch (stripeError) {
            console.error('[verifyStripe] Stripe retrieval error:', stripeError.message)
            return res.status(400).json({ success: false, message: 'Invalid Stripe session ID or retrieval failed' })
        }

        if (!session) {
            return res.status(400).json({ success: false, message: 'Stripe session not found' })
        }

        if (session.payment_status !== 'paid') {
            return res.status(400).json({ success: false, message: 'Payment not completed on Stripe' })
        }

        // Validate appointment ID and user ID against Stripe session metadata
        const sessionAppointmentId = session.metadata?.appointmentId || session.client_reference_id
        if (sessionAppointmentId && sessionAppointmentId.toString() !== appointmentId.toString()) {
            return res.status(400).json({ success: false, message: 'Stripe session does not match this appointment' })
        }

        if (session.metadata?.userId && session.metadata.userId.toString() !== userId.toString()) {
            return res.status(400).json({ success: false, message: 'Stripe session does not match this user' })
        }

        // Validate payment amount and currency
        const expectedAmountCents = Math.round(Number(appointmentData.amount) * 100)
        if (typeof session.amount_total === 'number' && session.amount_total !== expectedAmountCents) {
            return res.status(400).json({ success: false, message: 'Payment amount mismatch' })
        }

        const expectedCurrency = (process.env.CURRENCY || 'inr').toLowerCase()
        if (session.currency && session.currency.toLowerCase() !== expectedCurrency) {
            return res.status(400).json({ success: false, message: 'Payment currency mismatch' })
        }

        // Extract and verify the actual PaymentIntent
        let paymentIntent = session.payment_intent
        let paymentIntentId = null
        if (typeof paymentIntent === 'string') {
            paymentIntentId = paymentIntent
            try {
                paymentIntent = await stripeInstance.paymentIntents.retrieve(paymentIntentId)
            } catch (piErr) {
                console.error('[verifyStripe] PaymentIntent retrieval error:', piErr.message)
                return res.status(400).json({ success: false, message: 'Failed to verify Stripe PaymentIntent' })
            }
        } else if (paymentIntent && typeof paymentIntent === 'object') {
            paymentIntentId = paymentIntent.id
        }

        // Do not mark a Stripe payment successful if the PaymentIntent identifier is missing or payment not confirmed
        if (!paymentIntentId || !paymentIntent) {
            return res.status(400).json({ success: false, message: 'Stripe PaymentIntent is missing' })
        }

        if (paymentIntent.status !== 'succeeded') {
            return res.status(400).json({ success: false, message: `Stripe PaymentIntent is ${paymentIntent.status}, expected succeeded` })
        }

        // Idempotency: check if already paid
        if (appointmentData.payment === true) {
            if (appointmentData.paymentId === paymentIntentId) {
                return res.json({ success: true, message: 'Appointment already paid' })
            }
            if (appointmentData.paymentId && appointmentData.paymentId !== paymentIntentId) {
                return res.status(409).json({ success: false, message: 'Conflicting payment detected for this appointment' })
            }
        }

        // Atomic update: ensure appointment is marked paid only once (concurrency protection)
        const capturedAt = paymentIntent.created ? new Date(paymentIntent.created * 1000) : new Date()

        const updatedAppointment = await appointmentModel.findOneAndUpdate(
            {
                _id: appointmentId,
                $or: [
                    { payment: { $ne: true } },
                    { paymentId: paymentIntentId }
                ]
            },
            {
                $set: {
                    payment: true,
                    paymentMethod: 'stripe',
                    paymentId: paymentIntentId,
                    checkoutSessionId: session.id,
                    orderId: session.id,
                    paymentCurrency: session.currency.toUpperCase(),
                    paymentAmountMinor: session.amount_total,
                    paymentCapturedAt: capturedAt
                }
            },
            { new: true }
        )

        if (!updatedAppointment) {
            return res.status(409).json({ success: false, message: 'Conflicting payment detected for this appointment' })
        }

        // Safe claim pattern: transitions pending/failed or stale-sending to sending
        const STALE_TIMEOUT_MS = 5 * 60 * 1000
        const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MS)

        const claimed = await appointmentModel.findOneAndUpdate(
            {
                _id: appointmentId,
                receiptStatus: { $ne: 'sent' },
                receiptSent: { $ne: true },
                $or: [
                    { receiptStatus: { $in: ['pending', 'failed'] } },
                    { receiptStatus: 'sending', receiptClaimedAt: { $lt: staleThreshold } },
                    { receiptClaimedAt: null },
                    { receiptClaimedAt: { $exists: false } }
                ]
            },
            {
                $set: {
                    receiptStatus: 'sending',
                    receiptClaimedAt: new Date()
                }
            },
            { new: true }
        )

        // Task 4: Payment Receipt email (atomic delivery verification, non-blocking)
        if (claimed && appointmentData.userData?.email) {
            sendPaymentReceiptEmail({
                to: appointmentData.userData.email,
                userName: appointmentData.userData.name,
                docName: appointmentData.docData?.name || 'Doctor',
                slotDate: appointmentData.slotDate,
                slotTime: appointmentData.slotTime,
                amount: appointmentData.amount,
                paymentMethod: 'Stripe Checkout',
                transactionId: session.payment_intent ? session.payment_intent.toString() : session_id
            }).then(async (mailResult) => {
                if (mailResult && mailResult.sent) {
                    await appointmentModel.findByIdAndUpdate(appointmentId, {
                        $set: {
                            receiptStatus: 'sent',
                            receiptSent: true,
                            receiptClaimedAt: null
                        }
                    })
                } else {
                    console.log(`[mailer] Stripe receipt delivery failed or unconfigured for ${appointmentId}. Releasing claim for retry.`)
                    await appointmentModel.findByIdAndUpdate(appointmentId, {
                        $set: {
                            receiptStatus: 'failed',
                            receiptClaimedAt: null
                        }
                    })
                }
            }).catch(async (err) => {
                console.log('[mailer] Error sending Stripe receipt:', err.message)
                await appointmentModel.findByIdAndUpdate(appointmentId, {
                    $set: {
                        receiptStatus: 'failed',
                        receiptClaimedAt: null
                    }
                })
            })
        }

        return res.json({ success: true, message: 'Payment Successful' })

    } catch (error) {
        console.error('[verifyStripe] Error:', error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to add a review for a doctor (only for a completed appointment, one review per appointment)
const addReview = async (req, res) => {
    try {

        const { userId, appointmentId, rating, comment } = req.body

        if (!appointmentId || !rating) {
            return res.json({ success: false, message: 'Missing Details' })
        }

        if (rating < 1 || rating > 5) {
            return res.json({ success: false, message: 'Rating must be between 1 and 5' })
        }

        const appointmentData = await appointmentModel.findById(appointmentId)

        if (!appointmentData) {
            return res.json({ success: false, message: 'Appointment not found' })
        }

        if (appointmentData.userId !== userId) {
            return res.json({ success: false, message: 'Unauthorized action' })
        }

        if (!appointmentData.isCompleted) {
            return res.json({ success: false, message: 'You can only review a completed appointment' })
        }

        const existingReview = await reviewModel.findOne({ appointmentId })
        if (existingReview) {
            return res.json({ success: false, message: 'You have already reviewed this appointment' })
        }

        const userData = await userModel.findById(userId).select('-password')

        const reviewData = {
            userId,
            docId: appointmentData.docId,
            appointmentId,
            userName: userData.name,
            rating,
            comment: comment || '',
            date: Date.now()
        }

        await new reviewModel(reviewData).save()

        // recalculate doctor's average rating
        const allReviews = await reviewModel.find({ docId: appointmentData.docId })
        const reviewCount = allReviews.length
        const averageRating = allReviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount

        await doctorModel.findByIdAndUpdate(appointmentData.docId, {
            averageRating: Math.round(averageRating * 10) / 10,
            reviewCount
        })

        res.json({ success: true, message: 'Review Added' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }
}

// API to reschedule appointment
const rescheduleAppointment = async (req, res) => {
    try {
        const { userId, appointmentId, newSlotDate, newSlotTime } = req.body

        if (!appointmentId || !newSlotDate || !newSlotTime) {
            return res.status(400).json({ success: false, message: 'Missing reschedule parameters' })
        }

        const appointment = await appointmentModel.findById(appointmentId)
        if (!appointment) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        if (appointment.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
        }

        if (appointment.cancelled) {
            return res.status(400).json({ success: false, message: 'Cannot reschedule a cancelled appointment' })
        }

        if (appointment.isCompleted) {
            return res.status(400).json({ success: false, message: 'Cannot reschedule a completed appointment' })
        }

        const doctorData = await doctorModel.findById(appointment.docId)
        if (!doctorData || !doctorData.available) {
            return res.status(400).json({ success: false, message: 'Doctor is currently not available' })
        }

        let slots_booked = doctorData.slots_booked || {}

        // check if requested slot is already occupied
        if (slots_booked[newSlotDate] && slots_booked[newSlotDate].includes(newSlotTime)) {
            return res.status(409).json({ success: false, message: 'The requested slot is already booked' })
        }

        // Release old slot
        const oldDate = appointment.slotDate
        const oldTime = appointment.slotTime
        if (slots_booked[oldDate]) {
            slots_booked[oldDate] = slots_booked[oldDate].filter(t => t !== oldTime)
        }

        // Reserve new slot
        if (!slots_booked[newSlotDate]) {
            slots_booked[newSlotDate] = []
        }
        slots_booked[newSlotDate].push(newSlotTime)

        await doctorModel.findByIdAndUpdate(appointment.docId, { slots_booked })
        await appointmentModel.findByIdAndUpdate(appointmentId, {
            slotDate: newSlotDate,
            slotTime: newSlotTime
        })

        res.json({ success: true, message: 'Appointment rescheduled successfully' })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to send password reset OTP
const sendResetOtp = async (req, res) => {
    try {
        const { email } = req.body
        if (!email) {
            return res.status(400).json({ success: false, message: 'Email is required' })
        }

        const user = await userModel.findOne({ email })
        if (!user) {
            return res.json({ success: true, message: 'If an account exists, a reset OTP has been sent' })
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString()
        const otpExpire = Date.now() + 10 * 60 * 1000 // 10 minutes

        user.resetOtp = otp
        user.resetOtpExpire = otpExpire
        await user.save()

        await sendPasswordResetOtpEmail({
            to: user.email,
            userName: user.name,
            otp
        })

        res.json({ success: true, message: 'Password reset OTP sent to your email' })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to verify OTP and reset password
const resetPassword = async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body
        if (!email || !otp || !newPassword) {
            return res.status(400).json({ success: false, message: 'Email, OTP, and new password are required' })
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long' })
        }

        const user = await userModel.findOne({ email })
        if (!user || user.resetOtp !== otp || user.resetOtpExpire < Date.now()) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' })
        }

        const salt = await bcrypt.genSalt(10)
        const hashedPassword = await bcrypt.hash(newPassword, salt)

        user.password = hashedPassword
        user.resetOtp = ''
        user.resetOtpExpire = 0
        await user.save()

        res.json({ success: true, message: 'Password reset successfully. You can now login.' })
    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

export {
    loginUser,
    registerUser,
    getProfile,
    updateProfile,
    bookAppointment,
    listAppointment,
    cancelAppointment,
    paymentRazorpay,
    verifyRazorpay,
    paymentStripe,
    verifyStripe,
    addReview,
    rescheduleAppointment,
    sendResetOtp,
    resetPassword
}