import express from "express";
import { getMessages, sendMessage } from "../controllers/chatController.js";

const chatRouter = express.Router();

chatRouter.get("/messages/:appointmentId", getMessages);
chatRouter.post("/send", sendMessage);

export default chatRouter;
