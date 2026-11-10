import cron from "node-cron"
import appointmentModel from "../models/appointmentModel.js"
import { sendAppointmentReminderEmail, sendPaymentReceiptEmail } from "../config/mailer.js"

// Timeout after which a 'sending' claim is considered stale and available for recovery
export const CLAIM_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

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
 * Checks all active appointments and triggers 24-hour and 1-hour email reminders
 * using a safe pending -> sending -> sent/failed state machine with stale claim recovery.
 */
export const checkAndSendReminders = async () => {
    try {
        const now = new Date()
        const staleThreshold = new Date(Date.now() - CLAIM_TIMEOUT_MS)

        // Find candidate appointments that have not yet confirmed successful delivery
        const upcomingAppointments = await appointmentModel.find({
            cancelled: false,
            isCompleted: false,
            $or: [
                { reminderSent24h: { $ne: true }, reminder24hStatus: { $ne: 'sent' } },
                { reminderSent1h: { $ne: true }, reminder1hStatus: { $ne: 'sent' } }
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
            if (diffHours <= 2 && appt.reminderSent1h !== true && appt.reminder1hStatus !== 'sent') {
                // Atomic claim: only proceed if status is pending/failed OR sending claim has gone stale
                const claimed = await appointmentModel.findOneAndUpdate(
                    {
                        _id: appt._id,
                        reminder1hStatus: { $ne: 'sent' },
                        reminderSent1h: { $ne: true },
                        $or: [
                            { reminder1hStatus: { $in: ['pending', 'failed'] } },
                            { reminder1hStatus: 'sending', reminder1hClaimedAt: { $lt: staleThreshold } },
                            { reminder1hClaimedAt: null },
                            { reminder1hClaimedAt: { $exists: false } }
                        ]
                    },
                    {
                        $set: {
                            reminder1hStatus: 'sending',
                            reminder1hClaimedAt: new Date()
                        }
                    },
                    { new: true }
                )

                if (!claimed) continue

                // Attempt email delivery
                const mailResult = await sendAppointmentReminderEmail({
                    to: userEmail,
                    userName,
                    docName,
                    slotDate: appt.slotDate,
                    slotTime: appt.slotTime,
                    reminderType: '1-hour'
                })

                if (mailResult && mailResult.sent) {
                    // Mark as sent ONLY after mailer confirms successful delivery
                    await appointmentModel.findByIdAndUpdate(appt._id, {
                        $set: {
                            reminder1hStatus: 'sent',
                            reminderSent1h: true,
                            reminder1hClaimedAt: null,
                            reminder24hStatus: 'sent',
                            reminderSent24h: true
                        }
                    })
                    reminders1hSent++
                } else {
                    // If delivery fails, release claim and mark failed so it can be retried
                    console.log(`[scheduler] 1-hour reminder delivery failed for appointment ${appt._id}. Releasing claim for retry.`)
                    await appointmentModel.findByIdAndUpdate(appt._id, {
                        $set: {
                            reminder1hStatus: 'failed',
                            reminder1hClaimedAt: null
                        }
                    })
                }
                continue
            }

            // 24-Hour Reminder Window: between 2 and 24 hours remaining
            if (diffHours <= 24 && diffHours > 2 && appt.reminderSent24h !== true && appt.reminder24hStatus !== 'sent') {
                // Atomic claim: only proceed if status is pending/failed OR sending claim has gone stale
                const claimed = await appointmentModel.findOneAndUpdate(
                    {
                        _id: appt._id,
                        reminder24hStatus: { $ne: 'sent' },
                        reminderSent24h: { $ne: true },
                        $or: [
                            { reminder24hStatus: { $in: ['pending', 'failed'] } },
                            { reminder24hStatus: 'sending', reminder24hClaimedAt: { $lt: staleThreshold } },
                            { reminder24hClaimedAt: null },
                            { reminder24hClaimedAt: { $exists: false } }
                        ]
                    },
                    {
                        $set: {
                            reminder24hStatus: 'sending',
                            reminder24hClaimedAt: new Date()
                        }
                    },
                    { new: true }
                )

                if (!claimed) continue

                // Attempt email delivery
                const mailResult = await sendAppointmentReminderEmail({
                    to: userEmail,
                    userName,
                    docName,
                    slotDate: appt.slotDate,
                    slotTime: appt.slotTime,
                    reminderType: '24-hour'
                })

                if (mailResult && mailResult.sent) {
                    // Mark as sent ONLY after mailer confirms successful delivery
                    await appointmentModel.findByIdAndUpdate(appt._id, {
                        $set: {
                            reminder24hStatus: 'sent',
                            reminderSent24h: true,
                            reminder24hClaimedAt: null
                        }
                    })
                    reminders24hSent++
                } else {
                    // If delivery fails, release claim and mark failed so it can be retried
                    console.log(`[scheduler] 24-hour reminder delivery failed for appointment ${appt._id}. Releasing claim for retry.`)
                    await appointmentModel.findByIdAndUpdate(appt._id, {
                        $set: {
                            reminder24hStatus: 'failed',
                            reminder24hClaimedAt: null
                        }
                    })
                }
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
 * Retries un-dispatched payment receipts for verified appointments
 * using safe pending/failed/stale-sending atomic claiming.
 */
export const checkAndRetryReceipts = async () => {
    try {
        const staleThreshold = new Date(Date.now() - CLAIM_TIMEOUT_MS)

        const pendingReceipts = await appointmentModel.find({
            payment: true,
            cancelled: false,
            receiptSent: { $ne: true },
            receiptStatus: { $ne: 'sent' }
        })

        let receiptsSent = 0
        for (const appt of pendingReceipts) {
            const userEmail = appt.userData?.email
            if (!userEmail) continue

            const claimed = await appointmentModel.findOneAndUpdate(
                {
                    _id: appt._id,
                    receiptStatus: { $ne: 'sent' },
                    receiptSent: { $ne: true },
                    $or: [
                        { receiptStatus: { $in: ['pending', 'failed'] } },
                        { receiptStatus: 'sending', receiptClaimedAt: { $lt: staleThreshold } },
                        { receiptClaimedAt: null },
                        { receiptClaimedAt: { $exists: false } }
                    ]
                },
                {
                    $set: {
                        receiptStatus: 'sending',
                        receiptClaimedAt: new Date()
                    }
                },
                { new: true }
            )

            if (!claimed) continue

            const mailResult = await sendPaymentReceiptEmail({
                to: userEmail,
                userName: appt.userData?.name || 'Patient',
                docName: appt.docData?.name || 'Doctor',
                slotDate: appt.slotDate,
                slotTime: appt.slotTime,
                amount: appt.amount,
                paymentMethod: 'Online Payment',
                transactionId: 'VERIFIED'
            })

            if (mailResult && mailResult.sent) {
                await appointmentModel.findByIdAndUpdate(appt._id, {
                    $set: {
                        receiptStatus: 'sent',
                        receiptSent: true,
                        receiptClaimedAt: null
                    }
                })
                receiptsSent++
            } else {
                console.log(`[scheduler] Payment receipt delivery failed for appointment ${appt._id}. Releasing claim for retry.`)
                await appointmentModel.findByIdAndUpdate(appt._id, {
                    $set: {
                        receiptStatus: 'failed',
                        receiptClaimedAt: null
                    }
                })
            }
        }

        return { totalPending: pendingReceipts.length, receiptsSent }
    } catch (error) {
        console.error('[scheduler] Error in checkAndRetryReceipts:', error.message)
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
            await checkAndRetryReceipts()
        })
        console.log('[scheduler] Automated appointment reminder scheduler initialized (every 15 min)')
    } catch (error) {
        console.error('[scheduler] Failed to initialize cron scheduler:', error.message)
    }
}

export default {
    CLAIM_TIMEOUT_MS,
    parseAppointmentSlot,
    checkAndSendReminders,
    checkAndRetryReceipts,
    initReminderScheduler
}
