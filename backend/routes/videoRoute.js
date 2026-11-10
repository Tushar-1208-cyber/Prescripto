import express from "express"
import authUser from "../middleware/authUser.js"
import authDoctor from "../middleware/authDoctor.js"
import { getPatientVideoToken, getDoctorVideoToken } from "../controllers/videoController.js"

const videoRouter = express.Router()

// Patient endpoint: protected by patient JWT middleware
videoRouter.post("/patient-token", authUser, getPatientVideoToken)

// Doctor endpoint: protected by doctor JWT middleware
videoRouter.post("/doctor-token", authDoctor, getDoctorVideoToken)

export default videoRouter
