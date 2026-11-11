import crypto from "crypto";
import stripe from "stripe";
import appointmentModel from "../models/appointmentModel.js";
import webhookEventModel from "../models/webhookEventModel.js";
import { sendPaymentReceiptEmail } from "../config/mailer.js";
import {
    processRefund,
    isMatchingStripeRefund,
    isMatchingRazorpayRefund
} from "../services/refundService.js";

// Active client instances with mock injection support for test suites
let stripeInstance = process.env.STRIPE_SECRET_KEY ? new stripe(process.env.STRIPE_SECRET_KEY) : null;

export const setWebhookGatewayClients = ({ stripe: mockStripe }) => {
    if (mockStripe !== undefined) stripeInstance = mockStripe;
};

// Lease duration for event processing claim: 60 seconds
const LEASE_MS = 60 * 1000;
const RECEIPT_STALE_MS = 5 * 60 * 1000;

/**
 * Atomically claims a webhook event to ensure idempotency, serializing concurrent calls
 * and recovering from previous crashed attempts whose lease expired.
 */
export const claimWebhookEvent = async (provider, eventId, eventType, resourceId = null) => {
    const now = new Date();
    const claimExpiresAt = new Date(Date.now() + LEASE_MS);
    const claimToken = crypto.randomUUID();

    const existing = await webhookEventModel.findOne({ provider, eventId });
    if (existing) {
        if (existing.status === 'processed') {
            return { shouldProcess: false, duplicate: true, eventDoc: existing };
        }
        if (existing.status === 'processing' && existing.claimExpiresAt && existing.claimExpiresAt > now) {
            return { shouldProcess: false, duplicate: true, concurrent: true, eventDoc: existing };
        }

        // Event exists in 'received', 'failed', or crashed 'processing' with expired lease: acquire lease
        const claimed = await webhookEventModel.findOneAndUpdate(
            {
                provider,
                eventId,
                $or: [
                    { status: { $in: ['received', 'failed'] } },
                    { status: 'processing', claimExpiresAt: { $lte: now } }
                ]
            },
            {
                $set: {
                    status: 'processing',
                    claimToken,
                    claimExpiresAt,
                    resourceId: resourceId || existing.resourceId
                },
                $inc: { retryCount: 1 }
            },
            { new: true }
        );

        if (!claimed) {
            return { shouldProcess: false, duplicate: true, eventDoc: existing };
        }
        return { shouldProcess: true, claimToken, eventDoc: claimed };
    }

    // First time seeing this event: create record atomically
    try {
        const created = await webhookEventModel.create({
            provider,
            eventId,
            eventType,
            resourceId,
            status: 'processing',
            claimToken,
            claimExpiresAt,
            receivedAt: now
        });
        return { shouldProcess: true, claimToken, eventDoc: created };
    } catch (insertErr) {
        if (insertErr.code === 11000) {
            // Concurrent insert race: re-read status
            const current = await webhookEventModel.findOne({ provider, eventId });
            if (current?.status === 'processed') {
                return { shouldProcess: false, duplicate: true, eventDoc: current };
            }
            return { shouldProcess: false, duplicate: true, concurrent: true, eventDoc: current };
        }
        throw insertErr;
    }
};

/**
 * Marks a claimed webhook event as successfully processed.
 */
export const markEventProcessed = async (provider, eventId, claimToken, appointmentId = null) => {
    return await webhookEventModel.findOneAndUpdate(
        { provider, eventId, claimToken },
        {
            $set: {
                status: 'processed',
                processedAt: new Date(),
                claimToken: null,
                claimExpiresAt: null,
                ...(appointmentId ? { appointmentId: appointmentId.toString() } : {})
            }
        },
        { new: true }
    );
};

/**
 * Marks a claimed webhook event as failed with error details.
 */
export const markEventFailed = async (provider, eventId, claimToken, reason) => {
    return await webhookEventModel.findOneAndUpdate(
        { provider, eventId, claimToken },
        {
            $set: {
                status: 'failed',
                failureReason: reason ? reason.substring(0, 500) : 'Unknown failure',
                claimToken: null,
                claimExpiresAt: null
            }
        },
        { new: true }
    );
};

/**
 * POST /api/webhook/stripe
 * Stripe Webhook Integration
 */
export const handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not configured');
        return res.status(500).json({ success: false, message: 'Stripe webhook secret not configured' });
    }

    if (!sig) {
        return res.status(400).json({ success: false, message: 'Missing stripe-signature header' });
    }

    if (!req.rawBody) {
        return res.status(400).json({ success: false, message: 'Missing raw request body buffer' });
    }

    const activeStripe = stripeInstance || (process.env.STRIPE_SECRET_KEY ? new stripe(process.env.STRIPE_SECRET_KEY) : null);
    const webhookConstructor = activeStripe?.webhooks || stripe.webhooks;

    let event;
    try {
        event = webhookConstructor.constructEvent(req.rawBody, sig, webhookSecret);
    } catch (err) {
        console.error('[stripe-webhook] Signature verification failed:', err.message);
        return res.status(400).json({ success: false, message: `Invalid Stripe signature: ${err.message}` });
    }

    const eventId = event.id;
    const eventType = event.type;
    const resourceId = event.data?.object?.id || null;

    // Atomic claim lease for deduplication and crash safety
    let claimResult;
    try {
        claimResult = await claimWebhookEvent('stripe', eventId, eventType, resourceId);
    } catch (dbErr) {
        console.error('[stripe-webhook] Database error claiming event:', dbErr.message);
        return res.status(500).json({ success: false, message: 'Database error claiming webhook event' });
    }

    if (!claimResult.shouldProcess) {
        return res.status(200).json({ received: true, duplicate: true, message: 'Event already processed or in progress' });
    }

    const { claimToken } = claimResult;
    let targetAppointmentId = null;

    try {
        switch (eventType) {
            case 'checkout.session.completed':
            case 'checkout.session.async_payment_succeeded': {
                const session = event.data.object;
                if (session.payment_status !== 'paid') {
                    await markEventProcessed('stripe', eventId, claimToken);
                    return res.status(200).json({ received: true, message: 'Session payment status not paid' });
                }

                const appointmentId = session.metadata?.appointmentId || session.client_reference_id;
                if (!appointmentId) {
                    await markEventProcessed('stripe', eventId, claimToken);
                    return res.status(200).json({ received: true, message: 'No appointmentId in session metadata' });
                }

                targetAppointmentId = appointmentId;
                const appointment = await appointmentModel.findById(appointmentId);
                if (!appointment) {
                    await markEventProcessed('stripe', eventId, claimToken, appointmentId);
                    return res.status(200).json({ received: true, message: 'Appointment not found' });
                }

                // Currency and amount validation
                const expectedCurrency = (process.env.CURRENCY || 'inr').toLowerCase();
                if (session.currency && session.currency.toLowerCase() !== expectedCurrency) {
                    await markEventFailed('stripe', eventId, claimToken, 'Currency mismatch');
                    return res.status(400).json({ success: false, message: 'Payment currency mismatch' });
                }

                const expectedAmountMinor = Math.round(Number(appointment.amount) * 100);
                if (typeof session.amount_total === 'number' && session.amount_total !== expectedAmountMinor) {
                    await markEventFailed('stripe', eventId, claimToken, 'Amount mismatch');
                    return res.status(400).json({ success: false, message: 'Payment amount mismatch' });
                }

                const paymentIntentId = typeof session.payment_intent === 'string'
                    ? session.payment_intent
                    : session.payment_intent?.id || null;

                const capturedAt = session.created ? new Date(session.created * 1000) : new Date();

                // Check conflict: payment already marked with a different paymentId
                if (appointment.payment === true && appointment.paymentId && paymentIntentId && appointment.paymentId !== paymentIntentId) {
                    await markEventFailed('stripe', eventId, claimToken, 'Conflicting paymentId detected');
                    return res.status(409).json({ success: false, message: 'Conflicting payment detected for this appointment' });
                }

                // CRITICAL SCENARIO: Delayed payment confirmation after appointment cancellation
                if (appointment.cancelled) {
                    console.log(`[stripe-webhook] Delayed payment confirmed for cancelled appointment ${appointmentId}. Transitioning to refund.`);

                    // Persist verified payment identifiers without reactivating appointment or releasing slots
                    await appointmentModel.findOneAndUpdate(
                        { _id: appointmentId },
                        {
                            $set: {
                                payment: true,
                                paymentMethod: 'stripe',
                                paymentId: paymentIntentId || appointment.paymentId,
                                checkoutSessionId: session.id,
                                orderId: session.id,
                                paymentCurrency: (session.currency || expectedCurrency).toUpperCase(),
                                paymentAmountMinor: session.amount_total || expectedAmountMinor,
                                paymentCapturedAt: capturedAt,
                                // Transition refundStatus from not_applicable to pending if needed
                                ...(appointment.refundStatus === 'not_applicable' || !appointment.refundStatus || appointment.refundStatus === 'none'
                                    ? { refundStatus: 'pending' }
                                    : {})
                            }
                        }
                    );

                    // Trigger dedicated refund service safely
                    try {
                        await processRefund(appointmentId);
                    } catch (refundErr) {
                        console.error('[stripe-webhook] Post-cancellation refund processing error:', refundErr.message);
                    }

                    await markEventProcessed('stripe', eventId, claimToken, appointmentId);
                    return res.status(200).json({
                        received: true,
                        delayedPaymentCancelled: true,
                        message: 'Payment confirmed for cancelled appointment. Refund initiated.'
                    });
                }

                // NORMAL PAYMENT FLOW (Appointment active)
                const updated = await appointmentModel.findOneAndUpdate(
                    {
                        _id: appointmentId,
                        $or: [
                            { payment: { $ne: true } },
                            { paymentId: paymentIntentId }
                        ]
                    },
                    {
                        $set: {
                            payment: true,
                            paymentMethod: 'stripe',
                            paymentId: paymentIntentId || appointment.paymentId,
                            checkoutSessionId: session.id,
                            orderId: session.id,
                            paymentCurrency: (session.currency || expectedCurrency).toUpperCase(),
                            paymentAmountMinor: session.amount_total || expectedAmountMinor,
                            paymentCapturedAt: capturedAt
                        }
                    },
                    { new: true }
                );

                // Safe receipt delivery claim
                const staleReceiptThreshold = new Date(Date.now() - RECEIPT_STALE_MS);
                const claimedReceipt = await appointmentModel.findOneAndUpdate(
                    {
                        _id: appointmentId,
                        receiptStatus: { $ne: 'sent' },
                        receiptSent: { $ne: true },
                        $or: [
                            { receiptStatus: { $in: ['pending', 'failed'] } },
                            { receiptStatus: 'sending', receiptClaimedAt: { $lt: staleReceiptThreshold } },
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
                );

                if (claimedReceipt && appointment.userData?.email) {
                    sendPaymentReceiptEmail({
                        to: appointment.userData.email,
                        userName: appointment.userData.name,
                        docName: appointment.docData?.name || 'Doctor',
                        slotDate: appointment.slotDate,
                        slotTime: appointment.slotTime,
                        amount: appointment.amount,
                        paymentMethod: 'Stripe Checkout',
                        transactionId: paymentIntentId || session.id
                    }).then(async (mailResult) => {
                        if (mailResult && mailResult.sent) {
                            await appointmentModel.findByIdAndUpdate(appointmentId, {
                                $set: {
                                    receiptStatus: 'sent',
                                    receiptSent: true,
                                    receiptClaimedAt: null
                                }
                            });
                        } else {
                            await appointmentModel.findByIdAndUpdate(appointmentId, {
                                $set: {
                                    receiptStatus: 'failed',
                                    receiptClaimedAt: null
                                }
                            });
                        }
                    }).catch(err => console.error('[stripe-webhook] Receipt email dispatch error:', err.message));
                }

                await markEventProcessed('stripe', eventId, claimToken, appointmentId);
                return res.status(200).json({ received: true, success: true });
            }

            case 'checkout.session.async_payment_failed': {
                const session = event.data.object;
                const appointmentId = session.metadata?.appointmentId || session.client_reference_id;
                console.log(`[stripe-webhook] Async payment failed for appointment ${appointmentId}`);
                await markEventProcessed('stripe', eventId, claimToken, appointmentId);
                return res.status(200).json({ received: true, message: 'Async payment failure logged' });
            }

            case 'refund.updated': {
                const refund = event.data.object;
                const paymentIntentId = refund.payment_intent;

                if (!paymentIntentId) {
                    await markEventProcessed('stripe', eventId, claimToken);
                    return res.status(200).json({ received: true, message: 'No payment_intent on refund' });
                }

                const appointment = await appointmentModel.findOne({
                    $or: [
                        { paymentId: paymentIntentId },
                        { refundId: refund.id }
                    ]
                });

                if (!appointment) {
                    await markEventProcessed('stripe', eventId, claimToken);
                    return res.status(200).json({ received: true, message: 'No appointment matching refund payment intent' });
                }

                targetAppointmentId = appointment._id;

                // Validate matching criteria using strict validator
                if (!isMatchingStripeRefund(refund, appointment)) {
                    console.warn(`[stripe-webhook] Received refund ${refund.id} failed strict matching validation`);
                    await markEventProcessed('stripe', eventId, claimToken, appointment._id);
                    return res.status(200).json({ received: true, message: 'Refund failed strict matching criteria' });
                }

                if (refund.status === 'succeeded') {
                    await appointmentModel.findByIdAndUpdate(appointment._id, {
                        $set: {
                            refundStatus: 'refunded',
                            refundId: refund.id,
                            refundProviderStatus: 'succeeded',
                            refundAmount: appointment.paymentAmountMinor ? appointment.paymentAmountMinor / 100 : appointment.amount,
                            refundAmountMinor: appointment.paymentAmountMinor || (appointment.amount * 100),
                            refundCurrency: appointment.paymentCurrency || 'INR',
                            refundedAt: new Date(),
                            refundClaimedAt: null,
                            refundClaimToken: null,
                            refundFailureReason: null
                        }
                    });
                } else if (refund.status === 'failed') {
                    // Out-of-order protection: never downgrade 'refunded'
                    await appointmentModel.findOneAndUpdate(
                        { _id: appointment._id, refundStatus: { $ne: 'refunded' } },
                        {
                            $set: {
                                refundStatus: 'failed',
                                refundId: refund.id,
                                refundProviderStatus: 'failed',
                                refundFailureReason: refund.failure_reason || 'Stripe refund failed'
                            }
                        }
                    );
                }

                await markEventProcessed('stripe', eventId, claimToken, appointment._id);
                return res.status(200).json({ received: true, status: refund.status });
            }

            default:
                await markEventProcessed('stripe', eventId, claimToken);
                return res.status(200).json({ received: true, message: `Unhandled event type: ${eventType}` });
        }
    } catch (handlerErr) {
        console.error('[stripe-webhook] Handler execution error:', handlerErr.message);
        await markEventFailed('stripe', eventId, claimToken, handlerErr.message);
        return res.status(500).json({ success: false, message: 'Internal error processing webhook' });
    }
};

/**
 * POST /api/webhook/razorpay
 * Razorpay Webhook Integration
 */
export const handleRazorpayWebhook = async (req, res) => {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error('[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET is not configured');
        return res.status(500).json({ success: false, message: 'Razorpay webhook secret not configured' });
    }

    if (!signature) {
        return res.status(400).json({ success: false, message: 'Missing x-razorpay-signature header' });
    }

    if (!req.rawBody) {
        return res.status(400).json({ success: false, message: 'Missing raw request body buffer' });
    }

    // Verify HMAC-SHA256 signature using constant-time comparison
    const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(req.rawBody)
        .digest('hex');

    const signatureBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
        console.error('[razorpay-webhook] Signature verification failed');
        return res.status(400).json({ success: false, message: 'Invalid Razorpay signature' });
    }

    const payload = req.body;
    const eventType = payload.event;
    const eventId = req.headers['x-razorpay-event-id']
        || payload.event_id
        || `${eventType}_${payload.payload?.payment?.entity?.id || payload.payload?.order?.entity?.id || payload.payload?.refund?.entity?.id}_${payload.created_at}`;

    const resourceId = payload.payload?.payment?.entity?.id || payload.payload?.order?.entity?.id || payload.payload?.refund?.entity?.id || null;

    // Atomic claim lease for deduplication and crash safety
    let claimResult;
    try {
        claimResult = await claimWebhookEvent('razorpay', eventId, eventType, resourceId);
    } catch (dbErr) {
        console.error('[razorpay-webhook] Database error claiming event:', dbErr.message);
        return res.status(500).json({ success: false, message: 'Database error claiming webhook event' });
    }

    if (!claimResult.shouldProcess) {
        return res.status(200).json({ received: true, duplicate: true, message: 'Event already processed or in progress' });
    }

    const { claimToken } = claimResult;
    let targetAppointmentId = null;

    try {
        switch (eventType) {
            case 'order.paid':
            case 'payment.captured': {
                const order = payload.payload?.order?.entity;
                const payment = payload.payload?.payment?.entity;

                const appointmentId = order?.receipt || payment?.notes?.appointmentId || null;
                const orderId = order?.id || payment?.order_id || null;

                let appointment = null;
                if (appointmentId) {
                    appointment = await appointmentModel.findById(appointmentId);
                }
                if (!appointment && orderId) {
                    appointment = await appointmentModel.findOne({ orderId });
                }

                if (!appointment) {
                    await markEventProcessed('razorpay', eventId, claimToken);
                    return res.status(200).json({ received: true, message: 'Appointment not found for order/payment' });
                }

                targetAppointmentId = appointment._id;

                // Validate amount and currency
                const expectedCurrency = (process.env.CURRENCY || 'INR').toUpperCase();
                const paymentCurrency = (payment?.currency || order?.currency || expectedCurrency).toUpperCase();
                if (paymentCurrency !== expectedCurrency) {
                    await markEventFailed('razorpay', eventId, claimToken, 'Currency mismatch');
                    return res.status(400).json({ success: false, message: 'Payment currency mismatch' });
                }

                const expectedAmountMinor = Math.round(Number(appointment.amount) * 100);
                const actualAmountMinor = payment?.amount || order?.amount_paid || order?.amount;
                if (typeof actualAmountMinor === 'number' && actualAmountMinor !== expectedAmountMinor) {
                    await markEventFailed('razorpay', eventId, claimToken, 'Amount mismatch');
                    return res.status(400).json({ success: false, message: 'Payment amount mismatch' });
                }

                const paymentId = payment?.id || appointment.paymentId || null;
                const capturedAt = payment?.created_at ? new Date(payment.created_at * 1000) : new Date();

                // Conflict check
                if (appointment.payment === true && appointment.paymentId && paymentId && appointment.paymentId !== paymentId) {
                    await markEventFailed('razorpay', eventId, claimToken, 'Conflicting paymentId detected');
                    return res.status(409).json({ success: false, message: 'Conflicting payment detected for this appointment' });
                }

                // CRITICAL SCENARIO: Delayed payment confirmation after appointment cancellation
                if (appointment.cancelled) {
                    console.log(`[razorpay-webhook] Delayed payment confirmed for cancelled appointment ${appointment._id}. Transitioning to refund.`);

                    await appointmentModel.findOneAndUpdate(
                        { _id: appointment._id },
                        {
                            $set: {
                                payment: true,
                                paymentMethod: 'razorpay',
                                paymentId: paymentId || appointment.paymentId,
                                orderId: orderId || appointment.orderId,
                                paymentCurrency,
                                paymentAmountMinor: actualAmountMinor || expectedAmountMinor,
                                paymentCapturedAt: capturedAt,
                                ...(appointment.refundStatus === 'not_applicable' || !appointment.refundStatus || appointment.refundStatus === 'none'
                                    ? { refundStatus: 'pending' }
                                    : {})
                            }
                        }
                    );

                    // Trigger dedicated refund service safely
                    try {
                        await processRefund(appointment._id);
                    } catch (refundErr) {
                        console.error('[razorpay-webhook] Post-cancellation refund processing error:', refundErr.message);
                    }

                    await markEventProcessed('razorpay', eventId, claimToken, appointment._id);
                    return res.status(200).json({
                        received: true,
                        delayedPaymentCancelled: true,
                        message: 'Payment confirmed for cancelled appointment. Refund initiated.'
                    });
                }

                // NORMAL PAYMENT FLOW (Appointment active)
                const updated = await appointmentModel.findOneAndUpdate(
                    {
                        _id: appointment._id,
                        $or: [
                            { payment: { $ne: true } },
                            { paymentId: paymentId }
                        ]
                    },
                    {
                        $set: {
                            payment: true,
                            paymentMethod: 'razorpay',
                            paymentId: paymentId || appointment.paymentId,
                            orderId: orderId || appointment.orderId,
                            paymentCurrency,
                            paymentAmountMinor: actualAmountMinor || expectedAmountMinor,
                            paymentCapturedAt: capturedAt
                        }
                    },
                    { new: true }
                );

                // Safe receipt delivery claim
                const staleReceiptThreshold = new Date(Date.now() - RECEIPT_STALE_MS);
                const claimedReceipt = await appointmentModel.findOneAndUpdate(
                    {
                        _id: appointment._id,
                        receiptStatus: { $ne: 'sent' },
                        receiptSent: { $ne: true },
                        $or: [
                            { receiptStatus: { $in: ['pending', 'failed'] } },
                            { receiptStatus: 'sending', receiptClaimedAt: { $lt: staleReceiptThreshold } },
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
                );

                if (claimedReceipt && appointment.userData?.email) {
                    sendPaymentReceiptEmail({
                        to: appointment.userData.email,
                        userName: appointment.userData.name,
                        docName: appointment.docData?.name || 'Doctor',
                        slotDate: appointment.slotDate,
                        slotTime: appointment.slotTime,
                        amount: appointment.amount,
                        paymentMethod: 'Razorpay',
                        transactionId: paymentId || orderId
                    }).then(async (mailResult) => {
                        if (mailResult && mailResult.sent) {
                            await appointmentModel.findByIdAndUpdate(appointment._id, {
                                $set: {
                                    receiptStatus: 'sent',
                                    receiptSent: true,
                                    receiptClaimedAt: null
                                }
                            });
                        } else {
                            await appointmentModel.findByIdAndUpdate(appointment._id, {
                                $set: {
                                    receiptStatus: 'failed',
                                    receiptClaimedAt: null
                                }
                            });
                        }
                    }).catch(err => console.error('[razorpay-webhook] Receipt email dispatch error:', err.message));
                }

                await markEventProcessed('razorpay', eventId, claimToken, appointment._id);
                return res.status(200).json({ received: true, success: true });
            }

            case 'refund.processed': {
                const refund = payload.payload?.refund?.entity;
                const paymentId = refund.payment_id;

                if (!paymentId) {
                    await markEventProcessed('razorpay', eventId, claimToken);
                    return res.status(200).json({ received: true, message: 'No payment_id on refund' });
                }

                const appointment = await appointmentModel.findOne({
                    $or: [
                        { paymentId },
                        { refundId: refund.id }
                    ]
                });

                if (!appointment) {
                    await markEventProcessed('razorpay', eventId, claimToken);
                    return res.status(200).json({ received: true, message: 'No appointment matching refund payment_id' });
                }

                targetAppointmentId = appointment._id;

                if (!isMatchingRazorpayRefund(refund, appointment)) {
                    console.warn(`[razorpay-webhook] Received refund ${refund.id} failed strict matching validation`);
                    await markEventProcessed('razorpay', eventId, claimToken, appointment._id);
                    return res.status(200).json({ received: true, message: 'Refund failed strict matching criteria' });
                }

                await appointmentModel.findByIdAndUpdate(appointment._id, {
                    $set: {
                        refundStatus: 'refunded',
                        refundId: refund.id,
                        refundProviderStatus: 'processed',
                        refundAmount: appointment.paymentAmountMinor ? appointment.paymentAmountMinor / 100 : appointment.amount,
                        refundAmountMinor: appointment.paymentAmountMinor || (appointment.amount * 100),
                        refundCurrency: appointment.paymentCurrency || 'INR',
                        refundedAt: new Date(),
                        refundClaimedAt: null,
                        refundClaimToken: null,
                        refundFailureReason: null
                    }
                });

                await markEventProcessed('razorpay', eventId, claimToken, appointment._id);
                return res.status(200).json({ received: true, status: 'processed' });
            }

            case 'refund.failed': {
                const refund = payload.payload?.refund?.entity;
                const paymentId = refund.payment_id;

                const appointment = await appointmentModel.findOne({
                    $or: [
                        { paymentId },
                        { refundId: refund?.id }
                    ]
                });

                if (appointment) {
                    targetAppointmentId = appointment._id;
                    // Out-of-order protection: never downgrade 'refunded'
                    await appointmentModel.findOneAndUpdate(
                        { _id: appointment._id, refundStatus: { $ne: 'refunded' } },
                        {
                            $set: {
                                refundStatus: 'failed',
                                refundId: refund?.id || appointment.refundId,
                                refundProviderStatus: 'failed',
                                refundFailureReason: refund?.error_description || refund?.error_code || 'Razorpay refund failed'
                            }
                        }
                    );
                }

                await markEventProcessed('razorpay', eventId, claimToken, appointment?._id);
                return res.status(200).json({ received: true, status: 'failed' });
            }

            default:
                await markEventProcessed('razorpay', eventId, claimToken);
                return res.status(200).json({ received: true, message: `Unhandled event type: ${eventType}` });
        }
    } catch (handlerErr) {
        console.error('[razorpay-webhook] Handler execution error:', handlerErr.message);
        await markEventFailed('razorpay', eventId, claimToken, handlerErr.message);
        return res.status(500).json({ success: false, message: 'Internal error processing webhook' });
    }
};

export default {
    handleStripeWebhook,
    handleRazorpayWebhook,
    setWebhookGatewayClients,
    claimWebhookEvent,
    markEventProcessed,
    markEventFailed
};
