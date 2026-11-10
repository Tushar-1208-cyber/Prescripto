import jwt from 'jsonwebtoken'
import doctorModel from '../models/doctorModel.js'

// doctor authentication middleware
const authDoctor = async (req, res, next) => {
    const { dtoken } = req.headers
    if (!dtoken) {
        return res.status(401).json({ success: false, message: 'Not Authorized Login Again' })
    }
    try {
        const token_decode = jwt.verify(dtoken, process.env.JWT_SECRET)
        if (!token_decode || !token_decode.id) {
            return res.status(401).json({ success: false, message: 'Invalid token payload' })
        }

        const doctor = await doctorModel.findById(token_decode.id)
        if (!doctor) {
            return res.status(401).json({ success: false, message: 'Doctor account not found' })
        }

        if (doctor.isApproved === false) {
            return res.status(403).json({
                success: false,
                message: 'Your account is pending administrator approval. Access denied.'
            })
        }

        req.body.docId = token_decode.id
        req.doctor = doctor
        next()
    } catch (error) {
        console.log(error)
        res.status(401).json({ success: false, message: error.message })
    }
}

export default authDoctor;