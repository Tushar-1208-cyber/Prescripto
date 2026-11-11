import express from "express";
import {
    handleStripeWebhook,
    handleRazorpayWebhook
} from "../controllers/webhookController.js";

const webhookRouter = express.Router();

// Public webhook ingestion endpoints protected by cryptographic signature verification
webhookRouter.post("/stripe", handleStripeWebhook);
webhookRouter.post("/razorpay", handleRazorpayWebhook);

export default webhookRouter;
