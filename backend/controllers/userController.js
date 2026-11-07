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
import { sendAppointmentConfirmationEmail, sendAppointmentCancellationEmail } from "../config/mailer.js";

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
        const { userId, docId, slotDate, slotTime } = req.body

        if (!docId || !slotDate || !slotTime) {
            return res.status(400).json({ success: false, message: 'Missing appointment details' })
        }

        const docData = await doctorModel.findById(docId).select("-password")
        if (!docData) {
            return res.status(404).json({ success: false, message: 'Doctor not found' })
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
            date: Date.now()
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

        // send confirmation email (non-blocking for the booking flow)
        sendAppointmentConfirmationEmail({
            to: userData.email,
            userName: userData.name,
            docName: docData.name,
            slotDate,
            slotTime
        })

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

        if (appointmentData.cancelled) {
            return res.status(400).json({ success: false, message: 'Appointment is already cancelled' })
        }

        await appointmentModel.findByIdAndUpdate(appointmentId, { cancelled: true })

        // releasing doctor slot 
        const { docId, slotDate, slotTime } = appointmentData
        const doctorData = await doctorModel.findById(docId)

        if (doctorData && doctorData.slots_booked && doctorData.slots_booked[slotDate]) {
            let slots_booked = doctorData.slots_booked
            slots_booked[slotDate] = slots_booked[slotDate].filter(e => e !== slotTime)
            await doctorModel.findByIdAndUpdate(docId, { slots_booked })
        }

        // send cancellation email (non-blocking)
        sendAppointmentCancellationEmail({
            to: appointmentData.userData?.email,
            userName: appointmentData.userData?.name,
            docName: appointmentData.docData?.name,
            slotDate,
            slotTime
        })

        res.json({ success: true, message: 'Appointment Cancelled' })

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

        if (!razorpay_order_id) {
            return res.status(400).json({ success: false, message: 'Order ID is required' })
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

        // cryptographic signature validation
        if (razorpay_payment_id && razorpay_signature && process.env.RAZORPAY_KEY_SECRET) {
            const expectedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                .update(`${razorpay_order_id}|${razorpay_payment_id}`)
                .digest('hex')

            if (expectedSignature !== razorpay_signature) {
                return res.status(400).json({ success: false, message: 'Invalid payment signature' })
            }
        }

        if (orderInfo.status === 'paid') {
            await appointmentModel.findByIdAndUpdate(orderInfo.receipt, { payment: true })
            res.json({ success: true, message: "Payment Successful" })
        } else {
            res.status(400).json({ success: false, message: 'Payment Failed or incomplete' })
        }
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

        res.json({ success: true, session_url: session.url })

    } catch (error) {
        console.log(error)
        res.status(500).json({ success: false, message: error.message })
    }
}

// API to verify Stripe payment server-side
const verifyStripe = async (req, res) => {
    try {
        const { appointmentId, session_id, success, userId } = req.body

        if (!appointmentId) {
            return res.status(400).json({ success: false, message: 'Appointment ID required' })
        }

        const appointmentData = await appointmentModel.findById(appointmentId)
        if (!appointmentData) {
            return res.status(404).json({ success: false, message: 'Appointment not found' })
        }

        if (appointmentData.userId.toString() !== userId.toString()) {
            return res.status(403).json({ success: false, message: 'Unauthorized action' })
        }

        // Server-side verification with Stripe API
        if (session_id) {
            const session = await stripeInstance.checkout.sessions.retrieve(session_id)
            if (session.payment_status === 'paid') {
                await appointmentModel.findByIdAndUpdate(appointmentId, { payment: true })
                return res.json({ success: true, message: 'Payment Successful' })
            } else {
                return res.status(400).json({ success: false, message: 'Payment not completed on Stripe' })
            }
        }

        // Fallback backward compatibility
        if (success === "true" || success === true) {
            await appointmentModel.findByIdAndUpdate(appointmentId, { payment: true })
            return res.json({ success: true, message: 'Payment Successful' })
        }

        res.status(400).json({ success: false, message: 'Payment Failed' })

    } catch (error) {
        console.log(error)
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
    addReview
}