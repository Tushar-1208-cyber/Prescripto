import express from "express"
import cors from 'cors'
import helmet from 'helmet'
import 'dotenv/config'
import connectDB from "./config/mongodb.js"
import connectCloudinary from "./config/cloudinary.js"
import userRouter from "./routes/userRoute.js"
import doctorRouter from "./routes/doctorRoute.js"
import adminRouter from "./routes/adminRoute.js"

// app config
const app = express()
const port = process.env.PORT || 4000
connectDB()
connectCloudinary()

// middlewares
app.use(express.json())
app.use(helmet())

// CORS configuration supporting development and configurable production origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:3000']

app.use(cors({
    origin: (origin, callback) => {
        // allow requests with no origin (like mobile apps, postman, server-to-server) or during development
        if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
            return callback(null, true)
        }
        return callback(new Error('Blocked by CORS policy'))
    },
    credentials: true
}))

// api endpoints
app.use("/api/user", userRouter)
app.use("/api/admin", adminRouter)
app.use("/api/doctor", doctorRouter)

app.get("/", (_req, res) => {
  res.send("API Working")
});

// Centralized error handling middleware
app.use((err, _req, res, _next) => {
    console.error("Internal Server Error:", err.message)
    const statusCode = err.statusCode || 500
    res.status(statusCode).json({
        success: false,
        message: err.message || "Internal Server Error"
    })
})

app.listen(port, () => console.log(`Server started on PORT:${port}`))   