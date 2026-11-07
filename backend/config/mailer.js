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

export const sendPasswordResetOtpEmail = async ({ to, userName, otp }) => {
    return sendMail({
        to,
        subject: 'Prescripto - Password Reset OTP',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                <h2 style="color: #4f46e5; margin-bottom: 12px;">Reset Your Password</h2>
                <p>Hi ${userName || 'User'},</p>
                <p>You requested to reset your password. Use the verification OTP below to proceed:</p>
                <div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #1e293b; text-align: center; padding: 15px; background: #f1f5f9; border-radius: 6px; margin: 20px 0;">
                    ${otp}
                </div>
                <p style="color: #64748b; font-size: 13px;">This OTP is valid for 10 minutes. If you did not request this, please ignore this email.</p>
            </div>
        `,
    })
}

export const sendAppointmentReminderEmail = async ({ to, userName, docName, slotDate, slotTime }) => {
    return sendMail({
        to,
        subject: `Reminder: Upcoming appointment with Dr. ${docName}`,
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
                <h2 style="color: #4f46e5; margin-bottom: 12px;">Appointment Reminder</h2>
                <p>Hi ${userName},</p>
                <p>This is a friendly reminder for your upcoming consultation with <b>Dr. ${docName}</b>.</p>
                <div style="background: #f8fafc; border-left: 4px solid #4f46e5; padding: 12px 16px; margin: 16px 0;">
                    <p style="margin: 0; font-weight: bold;">Date: ${slotDate}</p>
                    <p style="margin: 4px 0 0 0; color: #475569;">Time: ${slotTime}</p>
                </div>
                <p style="color: #64748b; font-size: 13px;">Please arrive 10 minutes prior to your scheduled consultation time.</p>
            </div>
        `,
    })
}

export default { sendAppointmentConfirmationEmail, sendAppointmentCancellationEmail, sendPasswordResetOtpEmail, sendAppointmentReminderEmail }
