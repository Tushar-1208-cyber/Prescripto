import cron from "node-cron"
import appointmentModel from "../models/appointmentModel.js"
import { sendAppointmentReminderEmail } from "../config/mailer.js"

/**
 * Parses appointment slot date and time into a JavaScript Date object.
 * Format of slotDate: "DD_MM_YYYY" (e.g. "12_11_2026" or "1_2_2026")
 * Format of slotTime: "HH:MM AM/PM" or "HH:MM" (e.g. "10:00 AM", "04:30 pm", "14:00")
 */
export const parseAppointmentSlot = (slotDate, slotTime) => {
    if (!slotDate || !slotTime || typeof slotDate !== 'string' || typeof slotTime !== 'string') {
        return null
    }

    try {
        const parts = slotDate.split('_')
        if (parts.length !== 3) return null

        const day = parseInt(parts[0], 10)
        const month = parseInt(parts[1], 10)
        const year = parseInt(parts[2], 10)

        if (isNaN(day) || isNaN(month) || isNaN(year)) return null

        const timeMatch = slotTime.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([aApP][mM]))?$/)
        if (!timeMatch) return null

        let hours = parseInt(timeMatch[1], 10)
        const minutes = parseInt(timeMatch[2], 10)
        const period = timeMatch[3]?.toUpperCase()

        if (period === 'PM' && hours < 12) {
            hours += 12
        } else if (period === 'AM' && hours === 12) {
            hours = 0
        }

        const date = new Date(year, month - 1, day, hours, minutes, 0, 0)
        return isNaN(date.getTime()) ? null : date
    } catch {
        return null
    }
}

/**
 * Checks all active appointments and triggers 24-hour and 1-hour email reminders.
 * Returns statistics of reminders evaluated and dispatched.
 */
export const checkAndSendReminders = async () => {
    try {
        const now = new Date()
        const upcomingAppointments = await appointmentModel.find({
            cancelled: false,
            isCompleted: false,
            $or: [
                { reminderSent24h: { $ne: true } },
                { reminderSent1h: { $ne: true } }
            ]
        })

        let reminders24hSent = 0
        let reminders1hSent = 0

        for (const appt of upcomingAppointments) {
            const apptTime = parseAppointmentSlot(appt.slotDate, appt.slotTime)
            if (!apptTime) continue

            const diffMs = apptTime.getTime() - now.getTime()
            const diffHours = diffMs / (1000 * 60 * 60)

            // Skip past appointments
            if (diffHours < 0) continue

            const userEmail = appt.userData?.email
            const userName = appt.userData?.name || 'Valued Patient'
            const docName = appt.docData?.name || 'Doctor'

            if (!userEmail) continue

            // 1-Hour Reminder Window: between 0 and 2 hours remaining
            if (diffHours <= 2 && !appt.reminderSent1h) {
                // Atomic reservation: ensures only one worker in multi-instance/clustered environments sends the reminder
                const claimed = await appointmentModel.findOneAndUpdate(
                    { _id: appt._id, reminderSent1h: { $ne: true } },
                    { $set: { reminderSent1h: true, reminderSent24h: true } }
                )
                if (!claimed) continue

                await sendAppointmentReminderEmail({
                    to: userEmail,
                    userName,
                    docName,
                    slotDate: appt.slotDate,
                    slotTime: appt.slotTime,
                    reminderType: '1-hour'
                })

                reminders1hSent++
                continue
            }

            // 24-Hour Reminder Window: between 2 and 24 hours remaining
            if (diffHours <= 24 && diffHours > 2 && !appt.reminderSent24h) {
                // Atomic reservation: ensures only one worker in multi-instance/clustered environments sends the reminder
                const claimed = await appointmentModel.findOneAndUpdate(
                    { _id: appt._id, reminderSent24h: { $ne: true } },
                    { $set: { reminderSent24h: true } }
                )
                if (!claimed) continue

                await sendAppointmentReminderEmail({
                    to: userEmail,
                    userName,
                    docName,
                    slotDate: appt.slotDate,
                    slotTime: appt.slotTime,
                    reminderType: '24-hour'
                })

                reminders24hSent++
            }
        }

        console.log(`[scheduler] Reminders scan completed: ${reminders24hSent} 24h reminders sent, ${reminders1hSent} 1h reminders sent.`)
        return {
            totalEvaluated: upcomingAppointments.length,
            reminders24hSent,
            reminders1hSent
        }
    } catch (error) {
        console.error('[scheduler] Error in checkAndSendReminders:', error.message)
        return { error: error.message }
    }
}

/**
 * Initializes cron schedule to run every 15 minutes.
 */
export const initReminderScheduler = () => {
    try {
        // Run every 15 minutes: at minute 0, 15, 30, 45
        cron.schedule('*/15 * * * *', async () => {
            console.log('[scheduler] Executing automated appointment reminder cron job...')
            await checkAndSendReminders()
        })
        console.log('[scheduler] Automated appointment reminder scheduler initialized (every 15 min)')
    } catch (error) {
        console.error('[scheduler] Failed to initialize cron scheduler:', error.message)
    }
}

export default {
    parseAppointmentSlot,
    checkAndSendReminders,
    initReminderScheduler
}
