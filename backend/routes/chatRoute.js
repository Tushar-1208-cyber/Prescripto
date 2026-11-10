import express from "express";
import { getMessages, sendMessage, authChatParticipant } from "../controllers/chatController.js";

const chatRouter = express.Router();

chatRouter.get("/messages/:appointmentId", authChatParticipant, getMessages);
chatRouter.post("/send", authChatParticipant, sendMessage);

export default chatRouter;
