import jwt from 'jsonwebtoken'
import userModel from '../models/userModel.js'

// user authentication middleware
const authUser = async (req, res, next) => {
    const { token } = req.headers
    if (!token) {
        return res.status(401).json({ success: false, message: 'Not Authorized Login Again' })
    }
    try {
        const token_decode = jwt.verify(token, process.env.JWT_SECRET)
        if (!token_decode || !token_decode.id) {
            return res.status(401).json({ success: false, message: 'Invalid token payload' })
        }

        const user = await userModel.findById(token_decode.id)
        if (!user) {
            return res.status(401).json({ success: false, message: 'User account not found' })
        }

        if (user.isBlocked) {
            return res.status(403).json({
                success: false,
                message: 'Your account has been suspended. Please contact support.'
            })
        }

        // Never trust client-provided userId; derive strictly from verified token
        req.body.userId = token_decode.id
        req.user = user
        next()
    } catch (error) {
        console.log(error)
        res.status(401).json({ success: false, message: error.message })
    }
}

export default authUser;