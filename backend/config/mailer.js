import nodemailer from "nodemailer"

// Email is optional: if SMTP env vars are not set, we just skip sending
// (booking/cancellation flow must never fail because of email issues).
let transporter = null

const isEmailConfigured = () => {
    return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

const getTransporter = () => {
    if (!isEmailConfigured()) return null
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: Number(process.env.SMTP_PORT) === 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        })
    }
    return transporter
}

// Generic safe-send: never throws, only logs on failure
const sendMail = async ({ to, subject, html }) => {
    try {
        const t = getTransporter()
        if (!t || !to) {
            console.log(`[mailer] Skipped sending "${subject}" to ${to || 'unknown'} (SMTP not configured)`) 
            return { sent: false }
        }
        await t.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to,
            subject,
            html,
        })
        return { sent: true }
    } catch (error) {
        console.log('[mailer] Failed to send email:', error.message)
        return { sent: false, error: error.message }
    }
}

export const sendAppointmentConfirmationEmail = async ({ to, userName, docName, slotDate, slotTime }) => {
    return sendMail({
        to,
        subject: 'Your Prescripto appointment is confirmed',
        html: `
            <div style="font-family: Arial, sans-serif;">
                <h2>Appointment Confirmed</h2>
                <p>Hi ${userName},</p>
                <p>Your appointment with <b>Dr. ${docName}</b> has been booked successfully.</p>
                <p><b>Date:</b> ${slotDate}<br/><b>Time:</b> ${slotTime}</p>
                <p>Thank you for choosing Prescripto.</p>
            </div>
        `,
    })
}

export const sendAppointmentCancellationEmail = async ({ to, userName, docName, slotDate, slotTime }) => {
    return sendMail({
        to,
        subject: 'Your Prescripto appointment has been cancelled',
        html: `
            <div style="font-family: Arial, sans-serif;">
                <h2>Appointment Cancelled</h2>
                <p>Hi ${userName},</p>
                <p>Your appointment with <b>Dr. ${docName}</b> scheduled on ${slotDate} at ${slotTime} has been cancelled.</p>
                <p>You can book a new appointment anytime from your Prescripto account.</p>
            </div>
        `,
    })
}

export default { sendAppointmentConfirmationEmail, sendAppointmentCancellationEmail }
