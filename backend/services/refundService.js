import mongoose from "mongoose";
import stripe from "stripe";
import razorpay from "razorpay";
import appointmentModel from "../models/appointmentModel.js";

// Gateway instances initialized with environment credentials
let stripeInstance = process.env.STRIPE_SECRET_KEY ? new stripe(process.env.STRIPE_SECRET_KEY) : null;
let razorpayInstance = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
    ? new razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
    : null;

/**
 * Dependency injection helper for tests to supply mock gateway clients
 * without hitting live production APIs or requiring network access.
 */
export const setRefundGatewayClients = ({ stripe: mockStripe, razorpay: mockRazorpay }) => {
    if (mockStripe !== undefined) stripeInstance = mockStripe;
    if (mockRazorpay !== undefined) razorpayInstance = mockRazorpay;
};

/**
 * Helper to safely update database with fallback protection.
 * Distinguishes case where provider succeeded but DB update failed.
 */
const safeDbUpdate = async (appointmentId, updatePayload) => {
    try {
        const updated = await appointmentModel.findByIdAndUpdate(
            appointmentId,
            { $set: updatePayload },
            { new: true }
        );
        return { success: true, appointment: updated };
    } catch (dbErr) {
        console.error(`[CRITICAL] MongoDB update error for appointment ${appointmentId}:`, dbErr.message);
        // Emergency direct collection update fallback
        try {
            await appointmentModel.collection.updateOne(
                { _id: new mongoose.Types.ObjectId(appointmentId) },
                { $set: updatePayload }
            );
            return { success: true, fallback: true };
        } catch (fallbackErr) {
            console.error(`[CRITICAL] Emergency collection update also failed for appointment ${appointmentId}:`, fallbackErr.message);
            throw new Error(`DB_UPDATE_FAILED: ${dbErr.message}`);
        }
    }
};

/**
 * Handle Razorpay refund failure scenarios
 */
const handleRazorpayFailure = async (appointmentId, claimed, rzpErr, activeRzp) => {
    const errMsg = rzpErr.error?.description || rzpErr.message || '';
    const errCode = rzpErr.error?.code || '';
    const statusCode = rzpErr.statusCode || rzpErr.status || 0;

    // 1. Payment already refunded (idempotency safety check)
    const isAlreadyRefunded =
        errMsg.toLowerCase().includes('already') ||
        errCode === 'BAD_REQUEST_ERROR' && errMsg.toLowerCase().includes('refund');

    if (isAlreadyRefunded) {
        try {
            const existingRefunds = await activeRzp.payments.fetchMultipleRefund(claimed.paymentId);
            const latest = existingRefunds?.items?.[0];
            if (latest) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'refunded',
                    refundId: latest.id,
                    refundProviderStatus: latest.status || 'processed',
                    refundAmount: (claimed.paymentAmountMinor / 100),
                    refundAmountMinor: claimed.paymentAmountMinor,
                    refundCurrency: claimed.paymentCurrency,
                    refundedAt: new Date(),
                    refundClaimedAt: null,
                    refundFailureReason: null
                });
                return {
                    success: true,
                    status: 'refunded',
                    refundId: latest.id,
                    message: 'Payment was already fully refunded on Razorpay'
                };
            }
        } catch (fetchErr) {
            console.error('[refundService] Razorpay existing refund lookup error:', fetchErr.message);
        }
    }

    // 2. Ambiguous Network Timeout / Socket Hangup / 504
    const isTimeout =
        rzpErr.code === 'ETIMEDOUT' ||
        rzpErr.code === 'ECONNRESET' ||
        rzpErr.code === 'ESOCKETTIMEDOUT' ||
        statusCode === 504 ||
        errMsg.toLowerCase().includes('timeout');

    if (isTimeout) {
        // Must retain in 'pending' for reconciliation, NEVER mark definitive failure
        await safeDbUpdate(appointmentId, {
            refundStatus: 'pending',
            refundClaimedAt: null,
            refundFailureReason: `Ambiguous network timeout during Razorpay refund call: ${errMsg}. Reconcile before retrying.`
        });
        return {
            success: false,
            status: 'ambiguous_timeout',
            message: 'Network timeout occurred. State marked pending for reconciliation.',
            error: errMsg
        };
    }

    // 3. Temporary Provider Outage (500, 502, 503)
    const isTemporaryOutage = statusCode >= 500 && statusCode < 600;
    if (isTemporaryOutage) {
        await safeDbUpdate(appointmentId, {
            refundStatus: 'pending',
            refundClaimedAt: null,
            refundFailureReason: `Temporary Razorpay gateway outage (${statusCode}): ${errMsg}. Retryable.`
        });
        return {
            success: false,
            status: 'temporary_outage',
            message: 'Temporary provider outage. State marked pending for retry.',
            error: errMsg
        };
    }

    // 4. Definitive Provider Rejection (400, 401, 403, 404)
    await safeDbUpdate(appointmentId, {
        refundStatus: 'failed',
        refundClaimedAt: null,
        refundFailureReason: errMsg || 'Definitive gateway rejection by Razorpay'
    });
    return {
        success: false,
        status: 'failed',
        message: 'Refund rejected by Razorpay',
        error: errMsg
    };
};

/**
 * Handle Stripe refund failure scenarios
 */
const handleStripeFailure = async (appointmentId, claimed, stripeErr, activeStripe) => {
    const errCode = stripeErr.code || '';
    const errType = stripeErr.type || '';
    const errMsg = stripeErr.message || '';
    const statusCode = stripeErr.statusCode || stripeErr.status || 0;

    // 1. Charge / PaymentIntent already refunded (idempotency safety check)
    const isAlreadyRefunded =
        errCode === 'charge_already_refunded' ||
        errMsg.toLowerCase().includes('already refunded');

    if (isAlreadyRefunded) {
        try {
            const existingRefunds = await activeStripe.refunds.list({ payment_intent: claimed.paymentId });
            const successful = existingRefunds.data?.find(r => r.status === 'succeeded') || existingRefunds.data?.[0];
            if (successful) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'refunded',
                    refundId: successful.id,
                    refundProviderStatus: successful.status,
                    refundAmount: (claimed.paymentAmountMinor / 100),
                    refundAmountMinor: claimed.paymentAmountMinor,
                    refundCurrency: claimed.paymentCurrency,
                    refundedAt: new Date(),
                    refundClaimedAt: null,
                    refundFailureReason: null
                });
                return {
                    success: true,
                    status: 'refunded',
                    refundId: successful.id,
                    message: 'Payment was already fully refunded on Stripe'
                };
            }
        } catch (listErr) {
            console.error('[refundService] Stripe existing refund lookup error:', listErr.message);
        }
    }

    // 2. Ambiguous Network Timeout
    const isTimeout =
        errType === 'StripeConnectionError' ||
        stripeErr.code === 'ETIMEDOUT' ||
        errMsg.toLowerCase().includes('timeout');

    if (isTimeout) {
        await safeDbUpdate(appointmentId, {
            refundStatus: 'pending',
            refundClaimedAt: null,
            refundFailureReason: `Ambiguous network timeout during Stripe call: ${errMsg}. Reconcile before retrying.`
        });
        return {
            success: false,
            status: 'ambiguous_timeout',
            message: 'Network timeout occurred. State marked pending for reconciliation.',
            error: errMsg
        };
    }

    // 3. Temporary Outage (500, 502, 503)
    const isTemporaryOutage =
        statusCode >= 500 && statusCode < 600 ||
        errType === 'StripeAPIError' && statusCode >= 500;

    if (isTemporaryOutage) {
        await safeDbUpdate(appointmentId, {
            refundStatus: 'pending',
            refundClaimedAt: null,
            refundFailureReason: `Temporary Stripe service outage (${statusCode}): ${errMsg}. Retryable.`
        });
        return {
            success: false,
            status: 'temporary_outage',
            message: 'Temporary Stripe service outage. State marked pending for retry.',
            error: errMsg
        };
    }

    // 4. Definitive Provider Rejection (StripeCardError, StripeInvalidRequestError)
    await safeDbUpdate(appointmentId, {
        refundStatus: 'failed',
        refundClaimedAt: null,
        refundFailureReason: errMsg || 'Definitive gateway rejection by Stripe'
    });
    return {
        success: false,
        status: 'failed',
        message: 'Refund rejected by Stripe',
        error: errMsg
    };
};

/**
 * Main Refund Processor
 *
 * Implements isolated, idempotent, concurrency-safe refund execution.
 * Interface: processRefund(appointmentId, options)
 */
export const processRefund = async (appointmentId, options = {}) => {
    try {
        if (!appointmentId) {
            return { success: false, status: 'invalid_request', message: 'Appointment ID is required' };
        }

        const appointment = await appointmentModel.findById(appointmentId);
        if (!appointment) {
            return { success: false, status: 'not_found', message: 'Appointment not found' };
        }

        // 1. Validation before contacting provider:
        // Must be cancelled
        if (!appointment.cancelled) {
            return {
                success: false,
                status: 'not_cancelled',
                message: 'Cannot refund an active, non-cancelled appointment'
            };
        }

        // Cash appointments: not applicable
        if (appointment.isCash || appointment.paymentMode === 'cash' || appointment.paymentMethod === 'cash') {
            await appointmentModel.findByIdAndUpdate(appointmentId, { refundStatus: 'not_applicable' });
            return {
                success: false,
                status: 'not_applicable',
                message: 'Cash appointments are not eligible for online refund'
            };
        }

        // Unpaid appointments: not applicable
        if (!appointment.payment) {
            await appointmentModel.findByIdAndUpdate(appointmentId, { refundStatus: 'not_applicable' });
            return {
                success: false,
                status: 'not_applicable',
                message: 'Unpaid appointments are not eligible for refund'
            };
        }

        // Already refunded
        if (appointment.refundStatus === 'refunded') {
            return {
                success: true,
                status: 'refunded',
                refundId: appointment.refundId,
                message: 'Appointment has already been refunded'
            };
        }

        // Validate paymentMethod
        if (!appointment.paymentMethod || !['razorpay', 'stripe'].includes(appointment.paymentMethod)) {
            await appointmentModel.findByIdAndUpdate(appointmentId, {
                refundStatus: 'failed',
                refundFailureReason: 'Missing or unsupported paymentMethod for automated refund'
            });
            return {
                success: false,
                status: 'manual_review_required',
                message: 'Legacy or unknown payment method requires manual administrative review'
            };
        }

        // Validate paymentId
        if (!appointment.paymentId) {
            await appointmentModel.findByIdAndUpdate(appointmentId, {
                refundStatus: 'failed',
                refundFailureReason: 'Missing paymentId: legacy payment record requires manual review'
            });
            return {
                success: false,
                status: 'manual_review_required',
                message: 'Missing original payment identifier. Flagged for manual administrative review'
            };
        }

        // Validate verified payment amount and currency
        if (!appointment.paymentAmountMinor || typeof appointment.paymentAmountMinor !== 'number' || appointment.paymentAmountMinor <= 0 || !appointment.paymentCurrency) {
            await appointmentModel.findByIdAndUpdate(appointmentId, {
                refundStatus: 'failed',
                refundFailureReason: 'Missing verified payment amount or currency'
            });
            return {
                success: false,
                status: 'manual_review_required',
                message: 'Missing verified payment amount or currency. Flagged for manual administrative review'
            };
        }

        // Active gateway clients (allow injection from options or module state)
        const activeRazorpay = options.razorpay || razorpayInstance;
        const activeStripe = options.stripe || stripeInstance;

        // 2. Atomic concurrency lock via MongoDB findOneAndUpdate
        const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes freshness window
        const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MS);

        // Derive stable idempotency key (never regenerated on retry)
        const idempotencyKey = appointment.refundIdempotencyKey || `ref_${appointment._id.toString()}`;

        const claimQuery = {
            _id: appointment._id,
            payment: true,
            cancelled: true,
            refundStatus: { $ne: 'refunded' },
            $or: [
                { refundStatus: { $in: ['pending', 'failed', 'none'] } },
                { refundStatus: 'processing', refundClaimedAt: { $lt: staleThreshold } }
            ]
        };

        const claimUpdate = {
            $set: {
                refundStatus: 'processing',
                refundClaimedAt: new Date(),
                refundIdempotencyKey: idempotencyKey,
                refundAmountMinor: appointment.paymentAmountMinor,
                refundCurrency: appointment.paymentCurrency
            },
            $inc: { refundAttempts: 1 }
        };

        const claimed = await appointmentModel.findOneAndUpdate(claimQuery, claimUpdate, { new: true });
        if (!claimed) {
            const current = await appointmentModel.findById(appointmentId);
            if (current?.refundStatus === 'refunded') {
                return {
                    success: true,
                    status: 'refunded',
                    refundId: current.refundId,
                    message: 'Appointment has already been refunded'
                };
            }
            return {
                success: false,
                status: 'concurrency_locked',
                message: 'Refund is currently being processed by another worker'
            };
        }

        // 3. Razorpay Refund Flow
        if (claimed.paymentMethod === 'razorpay') {
            if (!activeRazorpay) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'failed',
                    refundClaimedAt: null,
                    refundFailureReason: 'Razorpay client not configured on server'
                });
                return { success: false, status: 'failed', message: 'Razorpay gateway not configured' };
            }

            try {
                const refundPayload = {
                    amount: claimed.paymentAmountMinor,
                    speed: 'normal',
                    notes: {
                        appointmentId: appointmentId.toString(),
                        idempotencyKey: idempotencyKey
                    },
                    receipt: idempotencyKey
                };

                const rzpRefund = await activeRazorpay.payments.refund(claimed.paymentId, refundPayload);

                if (!rzpRefund || !rzpRefund.id) {
                    await safeDbUpdate(appointmentId, {
                        refundStatus: 'failed',
                        refundClaimedAt: null,
                        refundFailureReason: 'Razorpay returned empty refund response'
                    });
                    return { success: false, status: 'failed', message: 'Empty refund response from Razorpay' };
                }

                if (rzpRefund.status === 'processed') {
                    try {
                        await safeDbUpdate(appointmentId, {
                            refundStatus: 'refunded',
                            refundId: rzpRefund.id,
                            refundProviderStatus: 'processed',
                            refundAmount: (claimed.paymentAmountMinor / 100),
                            refundAmountMinor: claimed.paymentAmountMinor,
                            refundCurrency: claimed.paymentCurrency,
                            refundedAt: new Date(),
                            refundClaimedAt: null,
                            refundFailureReason: null
                        });
                        return {
                            success: true,
                            status: 'refunded',
                            refundId: rzpRefund.id,
                            message: 'Refund successfully processed by Razorpay'
                        };
                    } catch (dbErr) {
                        return {
                            success: false,
                            status: 'db_update_failed',
                            refundId: rzpRefund.id,
                            message: 'Refund processed by Razorpay but database update encountered error',
                            error: dbErr.message
                        };
                    }
                } else if (rzpRefund.status === 'pending') {
                    await safeDbUpdate(appointmentId, {
                        refundStatus: 'pending',
                        refundId: rzpRefund.id,
                        refundProviderStatus: 'pending',
                        refundAmount: (claimed.paymentAmountMinor / 100),
                        refundAmountMinor: claimed.paymentAmountMinor,
                        refundCurrency: claimed.paymentCurrency,
                        refundClaimedAt: null,
                        refundFailureReason: 'Refund pending settlement by Razorpay'
                    });
                    return {
                        success: true,
                        status: 'pending',
                        refundId: rzpRefund.id,
                        message: 'Refund is pending settlement by Razorpay'
                    };
                } else {
                    await safeDbUpdate(appointmentId, {
                        refundStatus: 'failed',
                        refundId: rzpRefund.id || null,
                        refundProviderStatus: rzpRefund.status || 'unknown',
                        refundClaimedAt: null,
                        refundFailureReason: `Razorpay reported non-successful status: ${rzpRefund.status}`
                    });
                    return {
                        success: false,
                        status: 'failed',
                        refundId: rzpRefund.id,
                        message: `Razorpay refund status: ${rzpRefund.status}`
                    };
                }
            } catch (rzpErr) {
                return await handleRazorpayFailure(appointmentId, claimed, rzpErr, activeRazorpay);
            }
        }

        // 4. Stripe Refund Flow
        if (claimed.paymentMethod === 'stripe') {
            if (!activeStripe) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'failed',
                    refundClaimedAt: null,
                    refundFailureReason: 'Stripe client not configured on server'
                });
                return { success: false, status: 'failed', message: 'Stripe gateway not configured' };
            }

            try {
                const strRefund = await activeStripe.refunds.create({
                    payment_intent: claimed.paymentId,
                    amount: claimed.paymentAmountMinor,
                    reason: 'requested_by_customer',
                    metadata: {
                        appointmentId: appointmentId.toString(),
                        idempotencyKey: idempotencyKey
                    }
                }, {
                    idempotencyKey: idempotencyKey
                });

                if (!strRefund || !strRefund.id) {
                    await safeDbUpdate(appointmentId, {
                        refundStatus: 'failed',
                        refundClaimedAt: null,
                        refundFailureReason: 'Stripe returned empty refund response'
                    });
                    return { success: false, status: 'failed', message: 'Empty refund response from Stripe' };
                }

                if (strRefund.status === 'succeeded') {
                    try {
                        await safeDbUpdate(appointmentId, {
                            refundStatus: 'refunded',
                            refundId: strRefund.id,
                            refundProviderStatus: 'succeeded',
                            refundAmount: (claimed.paymentAmountMinor / 100),
                            refundAmountMinor: claimed.paymentAmountMinor,
                            refundCurrency: claimed.paymentCurrency,
                            refundedAt: new Date(),
                            refundClaimedAt: null,
                            refundFailureReason: null
                        });
                        return {
                            success: true,
                            status: 'refunded',
                            refundId: strRefund.id,
                            message: 'Refund successfully processed by Stripe'
                        };
                    } catch (dbErr) {
                        return {
                            success: false,
                            status: 'db_update_failed',
                            refundId: strRefund.id,
                            message: 'Refund processed by Stripe but database update encountered error',
                            error: dbErr.message
                        };
                    }
                } else if (strRefund.status === 'pending') {
                    await safeDbUpdate(appointmentId, {
                        refundStatus: 'pending',
                        refundId: strRefund.id,
                        refundProviderStatus: 'pending',
                        refundAmount: (claimed.paymentAmountMinor / 100),
                        refundAmountMinor: claimed.paymentAmountMinor,
                        refundCurrency: claimed.paymentCurrency,
                        refundClaimedAt: null,
                        refundFailureReason: 'Stripe refund is pending settlement'
                    });
                    return {
                        success: true,
                        status: 'pending',
                        refundId: strRefund.id,
                        message: 'Stripe refund is pending settlement'
                    };
                } else {
                    await safeDbUpdate(appointmentId, {
                        refundStatus: 'failed',
                        refundId: strRefund.id || null,
                        refundProviderStatus: strRefund.status || 'failed',
                        refundClaimedAt: null,
                        refundFailureReason: strRefund.failure_reason || `Stripe reported status: ${strRefund.status}`
                    });
                    return {
                        success: false,
                        status: 'failed',
                        refundId: strRefund.id,
                        message: `Stripe refund status: ${strRefund.status}`
                    };
                }
            } catch (strErr) {
                return await handleStripeFailure(appointmentId, claimed, strErr, activeStripe);
            }
        }

        return { success: false, status: 'unknown_provider', message: 'Unhandled payment method' };

    } catch (unexpectedError) {
        console.error(`[refundService] Unexpected error processing refund for ${appointmentId}:`, unexpectedError);
        return {
            success: false,
            status: 'internal_error',
            message: 'Internal server error processing refund',
            error: unexpectedError.message
        };
    }
};

/**
 * Reconcile Refund Status Directly with Payment Gateway
 *
 * Safe reconciliation helper for uncertain outcomes (e.g. timeouts or crashes).
 * Queries gateway to determine if a refund exists and syncs status to MongoDB.
 */
export const reconcileRefund = async (appointmentId, options = {}) => {
    try {
        const appointment = await appointmentModel.findById(appointmentId);
        if (!appointment) {
            return { success: false, status: 'not_found', message: 'Appointment not found' };
        }

        const activeRazorpay = options.razorpay || razorpayInstance;
        const activeStripe = options.stripe || stripeInstance;

        if (appointment.paymentMethod === 'stripe') {
            if (!activeStripe) throw new Error('Stripe client not configured');
            const refundsList = await activeStripe.refunds.list({ payment_intent: appointment.paymentId });
            const successful = refundsList.data?.find(r => r.status === 'succeeded');
            const pending = refundsList.data?.find(r => r.status === 'pending');

            if (successful) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'refunded',
                    refundId: successful.id,
                    refundProviderStatus: 'succeeded',
                    refundedAt: new Date(),
                    refundClaimedAt: null,
                    refundFailureReason: null
                });
                return { success: true, status: 'refunded', refundId: successful.id, message: 'Reconciled: refund confirmed on Stripe' };
            } else if (pending) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'pending',
                    refundId: pending.id,
                    refundProviderStatus: 'pending',
                    refundClaimedAt: null
                });
                return { success: true, status: 'pending', refundId: pending.id, message: 'Reconciled: refund is pending on Stripe' };
            } else {
                // No refund found on gateway: unlock claim to allow fresh retry
                await safeDbUpdate(appointmentId, {
                    refundClaimedAt: null,
                    refundFailureReason: 'Reconciled: No refund found on Stripe. Ready for retry.'
                });
                return { success: true, status: 'no_refund_found', message: 'No refund found on Stripe. Claim released for retry.' };
            }
        }

        if (appointment.paymentMethod === 'razorpay') {
            if (!activeRazorpay) throw new Error('Razorpay client not configured');
            const refundsList = await activeRazorpay.payments.fetchMultipleRefund(appointment.paymentId);
            const successful = refundsList?.items?.find(r => r.status === 'processed');
            const pending = refundsList?.items?.find(r => r.status === 'pending');

            if (successful) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'refunded',
                    refundId: successful.id,
                    refundProviderStatus: 'processed',
                    refundedAt: new Date(),
                    refundClaimedAt: null,
                    refundFailureReason: null
                });
                return { success: true, status: 'refunded', refundId: successful.id, message: 'Reconciled: refund confirmed on Razorpay' };
            } else if (pending) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'pending',
                    refundId: pending.id,
                    refundProviderStatus: 'pending',
                    refundClaimedAt: null
                });
                return { success: true, status: 'pending', refundId: pending.id, message: 'Reconciled: refund is pending on Razorpay' };
            } else {
                await safeDbUpdate(appointmentId, {
                    refundClaimedAt: null,
                    refundFailureReason: 'Reconciled: No refund found on Razorpay. Ready for retry.'
                });
                return { success: true, status: 'no_refund_found', message: 'No refund found on Razorpay. Claim released for retry.' };
            }
        }

        return { success: false, status: 'unsupported_method', message: 'Unsupported payment method for reconciliation' };
    } catch (error) {
        console.error(`[refundService] Error during reconciliation for ${appointmentId}:`, error.message);
        return { success: false, status: 'reconciliation_error', error: error.message };
    }
};

/**
 * Administrative Safe Retry for Failed Refunds
 */
export const retryFailedRefund = async (appointmentId, options = {}) => {
    const appointment = await appointmentModel.findById(appointmentId);
    if (!appointment) {
        return { success: false, status: 'not_found', message: 'Appointment not found' };
    }

    if (appointment.refundStatus === 'refunded') {
        return { success: true, status: 'already_refunded', message: 'Appointment is already refunded' };
    }

    // Reset claim and failure status to pending for fresh retry
    await appointmentModel.findByIdAndUpdate(appointmentId, {
        $set: {
            refundStatus: 'pending',
            refundClaimedAt: null,
            refundFailureReason: 'Admin retry requested'
        }
    });

    return await processRefund(appointmentId, options);
};

export default {
    processRefund,
    reconcileRefund,
    retryFailedRefund,
    setRefundGatewayClients
};
