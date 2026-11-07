import express from 'express';
import {
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
} from '../controllers/doctorController.js';
import authDoctor from '../middleware/authDoctor.js';
import upload from '../middleware/multer.js';
import { loginLimiter } from '../middleware/rateLimiter.js';
const doctorRouter = express.Router();

doctorRouter.post("/register", loginLimiter, upload.single('image'), registerDoctor)
doctorRouter.post("/login", loginLimiter, loginDoctor)
doctorRouter.get("/reviews/:docId", getDoctorReviews)
doctorRouter.post("/cancel-appointment", authDoctor, appointmentCancel)
doctorRouter.get("/appointments", authDoctor, appointmentsDoctor)
doctorRouter.get("/list", doctorList)
doctorRouter.post("/change-availability", authDoctor, changeAvailablity)
doctorRouter.post("/complete-appointment", authDoctor, appointmentComplete)
doctorRouter.post("/add-prescription", authDoctor, addPrescription)
doctorRouter.get("/dashboard", authDoctor, doctorDashboard)
doctorRouter.get("/profile", authDoctor, doctorProfile)
doctorRouter.post("/update-profile", authDoctor, updateDoctorProfile)

export default doctorRouter;