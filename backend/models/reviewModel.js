import mongoose from "mongoose"

const reviewSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    docId: { type: String, required: true },
    appointmentId: { type: String, required: true, unique: true }, // one review per appointment
    userName: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, default: '' },
    date: { type: Number, required: true }
})

const reviewModel = mongoose.models.review || mongoose.model("review", reviewSchema)
export default reviewModel
