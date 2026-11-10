import nodemailer from "nodemailer"

// Email is optional: if SMTP env vars are not set, we just skip sending
// (booking/cancellation/payment flow must never fail because of email issues).
let transporter = null

export const isEmailConfigured = () => {
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
export const sendMail = async ({ to, subject, html }) => {
    try {
        const t = getTransporter()
        if (!t || !to) {
            console.log(`[mailer] Skipped sending "${subject}" to ${to || 'unknown'} (SMTP not configured)`)
            return { sent: false, reason: 'SMTP not configured or recipient missing' }
        }
        const info = await t.sendMail({
            from: process.env.SMTP_FROM || `"Prescripto Healthcare" <${process.env.SMTP_USER}>`,
            to,
            subject,
            html,
        })
        console.log(`[mailer] Email sent successfully to ${to} (MessageId: ${info.messageId})`)
        return { sent: true, messageId: info.messageId }
    } catch (error) {
        console.log('[mailer] Failed to send email:', error.message)
        return { sent: false, error: error.message }
    }
}

// Task 1: Welcome email after successful patient registration
export const sendRegistrationWelcomeEmail = async ({ to, userName }) => {
    return sendMail({
        to,
        subject: 'Welcome to Prescripto Healthcare',
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b;">
                <div style="text-align: center; margin-bottom: 24px;">
                    <h1 style="color: #4f46e5; margin: 0; font-size: 26px;">Prescripto</h1>
                    <p style="color: #64748b; margin: 4px 0 0 0; font-size: 14px;">Your trusted healthcare partner</p>
                </div>
                <h2 style="color: #0f172a; font-size: 20px;">Welcome aboard, ${userName || 'Patient'}!</h2>
                <p style="line-height: 1.6; color: #334155;">Thank you for registering with Prescripto. Your account is ready, giving you instant access to trusted medical specialists, easy appointment scheduling, digital prescriptions, and direct doctor communication.</p>
                
                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 16px; margin: 20px 0;">
                    <h3 style="margin: 0 0 10px 0; font-size: 16px; color: #1e293b;">What you can do right away:</h3>
                    <ul style="margin: 0; padding-left: 20px; color: #475569; line-height: 1.6;">
                        <li>Browse verified doctors by speciality, experience, and fees</li>
                        <li>Book flexible appointment slots online</li>
                        <li>View and download digital prescriptions post-visit</li>
                        <li>Access your consultation records anytime</li>
                    </ul>
                </div>

                <p style="color: #64748b; font-size: 13px; margin-top: 24px; border-top: 1px solid #e2e8f0; padding-top: 16px;">If you have any questions or require assistance, our support team is always here to help.</p>
            </div>
        `,
    })
}

// Task 2: Patient confirmation email
export const sendAppointmentConfirmationEmail = async ({ to, userName, docName, slotDate, slotTime }) => {
    return sendMail({
        to,
        subject: `Appointment Confirmed with Dr. ${docName} - Prescripto`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h1 style="color: #4f46e5; margin: 0; font-size: 24px;">Prescripto</h1>
                </div>
                <h2 style="color: #16a34a; font-size: 20px; margin-bottom: 12px;">Appointment Confirmed!</h2>
                <p style="color: #334155;">Hi <b>${userName}</b>,</p>
                <p style="color: #334155;">Your consultation with <b>Dr. ${docName}</b> has been booked successfully.</p>
                <div style="background-color: #f8fafc; border-left: 4px solid #4f46e5; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
                    <p style="margin: 0; font-weight: bold; color: #0f172a;">Doctor: Dr. ${docName}</p>
                    <p style="margin: 6px 0 0 0; color: #334155;"><b>Date:</b> ${slotDate}</p>
                    <p style="margin: 4px 0 0 0; color: #334155;"><b>Time:</b> ${slotTime}</p>
                </div>
                <p style="color: #64748b; font-size: 13px;">Please make sure to log in or arrive 10 minutes before the scheduled time.</p>
            </div>
        `,
    })
}

// Task 2: Doctor notification email for new booking
export const sendDoctorBookingNotificationEmail = async ({ to, docName, userName, slotDate, slotTime, amount }) => {
    return sendMail({
        to,
        subject: `New Patient Appointment: ${userName} (${slotDate} at ${slotTime})`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h1 style="color: #4f46e5; margin: 0; font-size: 24px;">Prescripto Doctor Portal</h1>
                </div>
                <h2 style="color: #0f172a; font-size: 20px; margin-bottom: 12px;">New Appointment Booked</h2>
                <p style="color: #334155;">Hello <b>Dr. ${docName}</b>,</p>
                <p style="color: #334155;">A patient has booked a consultation slot with you on Prescripto.</p>
                <div style="background-color: #f8fafc; border-left: 4px solid #10b981; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
                    <p style="margin: 0; font-weight: bold; color: #0f172a;">Patient: ${userName}</p>
                    <p style="margin: 6px 0 0 0; color: #334155;"><b>Date:</b> ${slotDate}</p>
                    <p style="margin: 4px 0 0 0; color: #334155;"><b>Time:</b> ${slotTime}</p>
                    ${amount ? `<p style="margin: 4px 0 0 0; color: #334155;"><b>Consultation Fee:</b> ₹${amount}</p>` : ''}
                </div>
                <p style="color: #64748b; font-size: 13px;">You can review patient records and manage your schedule from your doctor dashboard.</p>
            </div>
        `,
    })
}

// Task 3: Cancellation notifications (for Patient, Doctor, or Admin initiated)
export const sendAppointmentCancellationEmail = async ({
    to,
    recipientName,
    userName,
    docName,
    slotDate,
    slotTime,
    cancelledBy = 'Patient',
    refundInfo = ''
}) => {
    const greetingName = recipientName || userName || 'User'
    return sendMail({
        to,
        subject: `Prescripto - Appointment Cancelled (${slotDate} at ${slotTime})`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h1 style="color: #4f46e5; margin: 0; font-size: 24px;">Prescripto</h1>
                </div>
                <h2 style="color: #ef4444; font-size: 20px; margin-bottom: 12px;">Appointment Cancelled</h2>
                <p style="color: #334155;">Hi <b>${greetingName}</b>,</p>
                <p style="color: #334155;">The scheduled consultation between <b>${userName}</b> and <b>Dr. ${docName}</b> on <b>${slotDate} at ${slotTime}</b> has been cancelled.</p>
                
                <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 14px 18px; margin: 18px 0; border-radius: 4px;">
                    <p style="margin: 0; color: #991b1b; font-weight: 600;">Status: Cancelled</p>
                    <p style="margin: 4px 0 0 0; color: #7f1d1d; font-size: 14px;">Initiated by: <b>${cancelledBy}</b></p>
                    ${refundInfo ? `<p style="margin: 6px 0 0 0; color: #15803d; font-weight: 500;">Refund: ${refundInfo}</p>` : ''}
                </div>
                <p style="color: #64748b; font-size: 13px;">If you wish to reschedule, you can book a new appointment anytime through the Prescripto portal.</p>
            </div>
        `,
    })
}

// Task 4: Payment Receipt email
export const sendPaymentReceiptEmail = async ({
    to,
    userName,
    docName,
    slotDate,
    slotTime,
    amount,
    paymentMethod = 'Online Gateway',
    transactionId = ''
}) => {
    return sendMail({
        to,
        subject: `Payment Receipt: Consultation with Dr. ${docName} - Prescripto`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b;">
                <div style="text-align: center; margin-bottom: 20px;">
                    <h1 style="color: #4f46e5; margin: 0; font-size: 24px;">Prescripto</h1>
                    <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px;">Official Payment Receipt</p>
                </div>
                <div style="background-color: #ecfdf5; border: 1px solid #a7f3d0; border-radius: 6px; padding: 12px 16px; margin-bottom: 20px; text-align: center;">
                    <span style="color: #065f46; font-weight: 600; font-size: 16px;">✓ Payment Verified & Received</span>
                </div>
                <p style="color: #334155;">Hi <b>${userName}</b>,</p>
                <p style="color: #334155;">Thank you for your payment. Here is the receipt for your upcoming consultation:</p>
                
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px;">
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 10px 0; color: #64748b;">Doctor:</td>
                        <td style="padding: 10px 0; text-align: right; font-weight: bold; color: #0f172a;">Dr. ${docName}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 10px 0; color: #64748b;">Date & Time:</td>
                        <td style="padding: 10px 0; text-align: right; color: #0f172a;">${slotDate} at ${slotTime}</td>
                    </tr>
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 10px 0; color: #64748b;">Payment Method:</td>
                        <td style="padding: 10px 0; text-align: right; color: #0f172a;">${paymentMethod}</td>
                    </tr>
                    ${transactionId ? `
                    <tr style="border-bottom: 1px solid #e2e8f0;">
                        <td style="padding: 10px 0; color: #64748b;">Transaction / Order ID:</td>
                        <td style="padding: 10px 0; text-align: right; font-family: monospace; color: #0f172a;">${transactionId}</td>
                    </tr>` : ''}
                    <tr style="border-top: 2px solid #0f172a;">
                        <td style="padding: 12px 0; font-weight: bold; font-size: 16px; color: #0f172a;">Total Amount:</td>
                        <td style="padding: 12px 0; text-align: right; font-weight: bold; font-size: 18px; color: #4f46e5;">₹${amount}</td>
                    </tr>
                </table>

                <p style="color: #64748b; font-size: 12px; margin-top: 20px; text-align: center;">This is an electronically generated receipt. Retain this for your medical expense records.</p>
            </div>
        `,
    })
}

// Password reset OTP email
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

// Task 5: 24-hour and 1-hour appointment reminder email
export const sendAppointmentReminderEmail = async ({ to, userName, docName, slotDate, slotTime, reminderType = '24-hour' }) => {
    const isOneHour = reminderType.toLowerCase().includes('1') || reminderType.toLowerCase().includes('one')
    const headline = isOneHour ? 'Consultation in 1 Hour' : 'Upcoming Consultation Tomorrow'
    const advice = isOneHour
        ? 'Your consultation starts in approximately 1 hour. Please ensure your internet connection is stable and have any prior medical records handy.'
        : 'This is a friendly reminder that your appointment is scheduled for tomorrow. Please let us know if you need to reschedule.'

    return sendMail({
        to,
        subject: `Reminder (${reminderType}): Consultation with Dr. ${docName}`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 500px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; color: #1e293b;">
                <h2 style="color: #4f46e5; margin-bottom: 8px;">${headline}</h2>
                <p style="color: #334155;">Hi <b>${userName}</b>,</p>
                <p style="color: #334155;">This is a reminder for your consultation with <b>Dr. ${docName}</b>.</p>
                <div style="background: #f8fafc; border-left: 4px solid #4f46e5; padding: 12px 16px; margin: 16px 0; border-radius: 4px;">
                    <p style="margin: 0; font-weight: bold; color: #0f172a;">Date: ${slotDate}</p>
                    <p style="margin: 4px 0 0 0; color: #475569;">Time: ${slotTime}</p>
                </div>
                <p style="color: #475569; font-size: 14px; line-height: 1.5;">${advice}</p>
                <p style="color: #64748b; font-size: 12px; margin-top: 18px; border-top: 1px solid #e2e8f0; padding-top: 10px;">Prescripto Automated Reminder System</p>
            </div>
        `,
    })
}

export default {
    sendMail,
    isEmailConfigured,
    sendRegistrationWelcomeEmail,
    sendAppointmentConfirmationEmail,
    sendDoctorBookingNotificationEmail,
    sendAppointmentCancellationEmail,
    sendPaymentReceiptEmail,
    sendPasswordResetOtpEmail,
    sendAppointmentReminderEmail,
}
