import mongoose from "mongoose";

const connectDB = async () => {
    try {
        mongoose.connection.on('connected', () => console.log("Database Connected Successfully"))
        
        let uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
        if (!uri.includes("prescripto")) {
            if (uri.includes("?")) {
                const parts = uri.split("?");
                uri = `${parts[0].replace(/\/$/, '')}/prescripto?${parts[1]}`;
            } else {
                uri = uri.endsWith("/") ? `${uri}prescripto` : `${uri}/prescripto`;
            }
        }
        
        await mongoose.connect(uri);
    } catch (error) {
        console.error("MongoDB Connection Error:", error.message);
    }
}

export default connectDB;