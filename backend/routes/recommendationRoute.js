import express from 'express'
import rateLimit from 'express-rate-limit'
import { getDoctorRecommendations } from '../controllers/recommendationController.js'

const recommendationRouter = express.Router()

// Protect AI recommendation endpoint against abuse: 30 requests per 10 minutes per IP
const recommendationLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: 'Too many recommendation requests from this IP. Please wait a few minutes before trying again.'
    }
})

recommendationRouter.post('/find-doctors', recommendationLimiter, getDoctorRecommendations)

export default recommendationRouter
