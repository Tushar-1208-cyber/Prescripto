import jwt from "jsonwebtoken";
import appointmentModel from "../models/appointmentModel.js";
import doctorModel from "../models/doctorModel.js";
import bcrypt from "bcrypt";
import validator from "validator";
import { v2 as cloudinary } from "cloudinary";
import userModel from "../models/userModel.js";
import { sendAppointmentReminderEmail } from "../config/mailer.js";

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

// API for appointment cancellation
const appointmentCancel = async (req, res) => {
    try {

        const { appointmentId } = req.body
        await appointmentModel.findByIdAndUpdate(appointmentId, { cancelled: true })

        res.json({ success: true, message: 'Appointment Cancelled' })

    } catch (error) {
        console.log(error)
        res.json({ success: false, message: error.message })
    }

}

// API for adding Doctor
const addDoctor = async (req, res) => {

    try {

        const { name, email, password, speciality, degree, experience, about, fees, address } = req.body
        const imageFile = req.file

        // checking for all data to add doctor
        if (!name || !email || !password || !speciality || !degree || !experience || !about || !fees || !address) {
            return res.json({ success: false, message: "Missing Details" })
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
        const upcomingAppointments = await appointmentModel.find({
            cancelled: false,
            isCompleted: false,
            reminderSent24h: { $ne: true }
        })

        let sentCount = 0
        for (const item of upcomingAppointments) {
            if (item.userData?.email && item.docData?.name) {
                await sendAppointmentReminderEmail({
                    to: item.userData.email,
                    userName: item.userData.name,
                    docName: item.docData.name,
                    slotDate: item.slotDate,
                    slotTime: item.slotTime
                })
                await appointmentModel.findByIdAndUpdate(item._id, { reminderSent24h: true })
                sentCount++
            }
        }

        res.json({ success: true, message: `Reminders sent for ${sentCount} upcoming appointment(s)` })
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
        const doctor = await doctorModel.findById(docId)
        if (!doctor) {
            return res.status(404).json({ success: false, message: 'Doctor not found' })
        }
        await doctorModel.findByIdAndDelete(docId)
        res.json({ success: true, message: 'Doctor deleted successfully' })
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
    deleteDoctor
}