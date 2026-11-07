import express from 'express';
import {
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
} from '../controllers/userController.js';
import upload from '../middleware/multer.js';
import authUser from '../middleware/authUser.js';
import { loginLimiter } from '../middleware/rateLimiter.js';
const userRouter = express.Router();

userRouter.post("/register", loginLimiter, registerUser)
userRouter.post("/login", loginLimiter, loginUser)
userRouter.post("/send-reset-otp", loginLimiter, sendResetOtp)
userRouter.post("/reset-password", loginLimiter, resetPassword)
userRouter.post("/add-review", authUser, addReview)

userRouter.get("/get-profile", authUser, getProfile)
userRouter.post("/update-profile", upload.single('image'), authUser, updateProfile)
userRouter.post("/book-appointment", authUser, bookAppointment)
userRouter.get("/appointments", authUser, listAppointment)
userRouter.post("/cancel-appointment", authUser, cancelAppointment)
userRouter.post("/reschedule-appointment", authUser, rescheduleAppointment)
userRouter.post("/payment-razorpay", authUser, paymentRazorpay)
userRouter.post("/verifyRazorpay", authUser, verifyRazorpay)
userRouter.post("/payment-stripe", authUser, paymentStripe)
userRouter.post("/verifyStripe", authUser, verifyStripe)

export default userRouter;