import mongoose from "mongoose";
import crypto from "crypto";
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

// Default authenticated HTTP requester for Razorpay (sends X-Refund-Idempotency)
let razorpayHttpRequester = null;

/**
 * Dependency injection helper for tests to supply mock gateway clients
 * without hitting live production APIs or requiring network access.
 */
export const setRefundGatewayClients = ({ stripe: mockStripe, razorpay: mockRazorpay, razorpayHttpRequester: mockHttp }) => {
    if (mockStripe !== undefined) stripeInstance = mockStripe;
    if (mockRazorpay !== undefined) razorpayInstance = mockRazorpay;
    if (mockHttp !== undefined) razorpayHttpRequester = mockHttp;
};

/**
 * Direct authenticated HTTP request to Razorpay REST API
 * Guarantees propagation of X-Refund-Idempotency header which the official SDK strips.
 */
const defaultRazorpayRequest = async ({ path, method = 'POST', data = null, headers = {} }) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
        throw new Error('Razorpay credentials not configured');
    }

    const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const url = `https://api.razorpay.com/v1${path}`;

    const requestHeaders = {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        ...headers
    };

    const fetchOptions = {
        method,
        headers: requestHeaders
    };

    if (data && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
        fetchOptions.body = JSON.stringify(data);
    }

    const res = await fetch(url, fetchOptions);
    const body = await res.json().catch(() => null);

    if (!res.ok) {
        const error = new Error(body?.error?.description || `Razorpay HTTP error: ${res.statusText}`);
        error.statusCode = res.status;
        error.error = body?.error || { description: error.message };
        throw error;
    }

    return body;
};

/**
 * Execute Razorpay HTTP request using active or injected requester
 */
const executeRazorpayHttp = async (reqOptions, customRequester) => {
    const requester = customRequester || razorpayHttpRequester || defaultRazorpayRequest;
    return await requester(reqOptions);
};

/**
 * Helper to safely update database with lock-ownership verification and fallback protection.
 * If claimToken is passed, verifies worker still owns the lock before modifying state.
 */
const safeDbUpdate = async (appointmentId, updatePayload, claimToken = null) => {
    const query = { _id: appointmentId };
    if (claimToken) {
        query.refundClaimToken = claimToken;
    }

    try {
        const updated = await appointmentModel.findOneAndUpdate(
            query,
            { $set: updatePayload },
            { new: true }
        );

        if (!updated && claimToken) {
            console.warn(`[refundService] Claim lock for appointment ${appointmentId} was lost or expired (claimToken mismatch). Stale worker aborting update.`);
            return { success: false, lostLock: true };
        }

        return { success: true, appointment: updated };
    } catch (dbErr) {
        console.error(`[CRITICAL] MongoDB update error for appointment ${appointmentId}:`, dbErr.message);
        // Emergency direct collection update fallback
        try {
            const fallbackQuery = { _id: new mongoose.Types.ObjectId(appointmentId) };
            if (claimToken) {
                fallbackQuery.refundClaimToken = claimToken;
            }
            const res = await appointmentModel.collection.updateOne(
                fallbackQuery,
                { $set: updatePayload }
            );
            if (res.matchedCount === 0 && claimToken) {
                return { success: false, lostLock: true };
            }
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
const handleRazorpayFailure = async (appointmentId, claimed, rzpErr, claimToken, customRequester) => {
    const errMsg = rzpErr.error?.description || rzpErr.message || '';
    const errCode = rzpErr.error?.code || '';
    const statusCode = rzpErr.statusCode || rzpErr.status || 0;

    // 1. Payment already refunded (idempotency safety check)
    const isAlreadyRefunded =
        errMsg.toLowerCase().includes('already') ||
        (errCode === 'BAD_REQUEST_ERROR' && errMsg.toLowerCase().includes('refund'));

    if (isAlreadyRefunded) {
        try {
            const existingRefunds = await executeRazorpayHttp({
                path: `/payments/${claimed.paymentId}/refunds`,
                method: 'GET'
            }, customRequester);

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
                    refundClaimToken: null,
                    refundFailureReason: null
                }, claimToken);

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
            refundClaimToken: null,
            refundFailureReason: `Ambiguous network timeout during Razorpay refund call: ${errMsg}. Reconcile before retrying.`
        }, claimToken);

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
            refundClaimToken: null,
            refundFailureReason: `Temporary Razorpay gateway outage (${statusCode}): ${errMsg}. Retryable.`
        }, claimToken);

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
        refundClaimToken: null,
        refundFailureReason: errMsg || 'Definitive gateway rejection by Razorpay'
    }, claimToken);

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
const handleStripeFailure = async (appointmentId, claimed, stripeErr, activeStripe, claimToken) => {
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
                    refundClaimToken: null,
                    refundFailureReason: null
                }, claimToken);

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
            refundClaimToken: null,
            refundFailureReason: `Ambiguous network timeout during Stripe call: ${errMsg}. Reconcile before retrying.`
        }, claimToken);

        return {
            success: false,
            status: 'ambiguous_timeout',
            message: 'Network timeout occurred. State marked pending for reconciliation.',
            error: errMsg
        };
    }

    // 3. Temporary Outage (500, 502, 503)
    const isTemporaryOutage =
        (statusCode >= 500 && statusCode < 600) ||
        (errType === 'StripeAPIError' && statusCode >= 500);

    if (isTemporaryOutage) {
        await safeDbUpdate(appointmentId, {
            refundStatus: 'pending',
            refundClaimedAt: null,
            refundClaimToken: null,
            refundFailureReason: `Temporary Stripe service outage (${statusCode}): ${errMsg}. Retryable.`
        }, claimToken);

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
        refundClaimToken: null,
        refundFailureReason: errMsg || 'Definitive gateway rejection by Stripe'
    }, claimToken);

    return {
        success: false,
        status: 'failed',
        message: 'Refund rejected by Stripe',
        error: errMsg
    };
};

/**
 * Poll or Retrieve Existing Refund
 *
 * Mandatory protection against submitting duplicate create-refund requests
 * when an appointment already possesses a refundId.
 */
const pollExistingRefund = async (appointment, options = {}) => {
    const appointmentId = appointment._id.toString();
    const activeStripe = options.stripe || stripeInstance;
    const customHttp = options.razorpayHttpRequester || razorpayHttpRequester;

    // Acquire lock for polling to prevent concurrent status modification
    const claimToken = crypto.randomUUID();
    const STALE_TIMEOUT_MS = 5 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MS);

    const claimed = await appointmentModel.findOneAndUpdate(
        {
            _id: appointment._id,
            $or: [
                { refundClaimedAt: null },
                { refundClaimedAt: { $lt: staleThreshold } }
            ]
        },
        {
            $set: {
                refundClaimedAt: new Date(),
                refundClaimToken: claimToken
            }
        },
        { new: true }
    );

    if (!claimed) {
        return {
            success: false,
            status: 'concurrency_locked',
            message: 'Existing refund is currently being verified by another worker'
        };
    }

    try {
        if (appointment.paymentMethod === 'stripe') {
            if (!activeStripe) throw new Error('Stripe client not configured');
            const strRefund = await activeStripe.refunds.retrieve(appointment.refundId);

            if (strRefund.status === 'succeeded') {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'refunded',
                    refundProviderStatus: 'succeeded',
                    refundedAt: new Date(),
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: null
                }, claimToken);
                return { success: true, status: 'refunded', refundId: strRefund.id, message: 'Existing refund confirmed succeeded on Stripe' };
            } else if (strRefund.status === 'pending') {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'pending',
                    refundProviderStatus: 'pending',
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: 'Existing refund still pending with Stripe'
                }, claimToken);
                return { success: true, status: 'pending', refundId: strRefund.id, message: 'Existing refund is still pending with Stripe' };
            } else {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'failed',
                    refundProviderStatus: strRefund.status,
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: strRefund.failure_reason || `Stripe reported status: ${strRefund.status}`
                }, claimToken);
                return { success: false, status: 'failed', refundId: strRefund.id, message: `Existing Stripe refund status: ${strRefund.status}` };
            }
        }

        if (appointment.paymentMethod === 'razorpay') {
            const rzpRefund = await executeRazorpayHttp({
                path: `/refunds/${appointment.refundId}`,
                method: 'GET'
            }, customHttp);

            if (rzpRefund.status === 'processed') {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'refunded',
                    refundProviderStatus: 'processed',
                    refundedAt: new Date(),
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: null
                }, claimToken);
                return { success: true, status: 'refunded', refundId: rzpRefund.id, message: 'Existing refund confirmed processed on Razorpay' };
            } else if (rzpRefund.status === 'pending') {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'pending',
                    refundProviderStatus: 'pending',
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: 'Existing refund still pending with Razorpay'
                }, claimToken);
                return { success: true, status: 'pending', refundId: rzpRefund.id, message: 'Existing refund is still pending with Razorpay' };
            } else {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'failed',
                    refundProviderStatus: rzpRefund.status,
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: `Razorpay reported status: ${rzpRefund.status}`
                }, claimToken);
                return { success: false, status: 'failed', refundId: rzpRefund.id, message: `Existing Razorpay refund status: ${rzpRefund.status}` };
            }
        }

        await safeDbUpdate(appointmentId, { refundClaimedAt: null, refundClaimToken: null }, claimToken);
        return { success: false, status: 'unsupported_method', message: 'Unsupported payment method for polling' };
    } catch (err) {
        await safeDbUpdate(appointmentId, { refundClaimedAt: null, refundClaimToken: null }, claimToken);
        console.error(`[refundService] Error polling existing refund ${appointment.refundId}:`, err.message);
        return { success: false, status: 'polling_error', error: err.message };
    }
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

        // PENDING REFUND PROTECTION:
        // If an appointment already has a refundId, NEVER submit another create-refund request!
        // Retrieve and poll that exact existing refund with the provider.
        if (appointment.refundId) {
            return await pollExistingRefund(appointment, options);
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

        // Active gateway clients
        const activeStripe = options.stripe || stripeInstance;
        const customRzpHttp = options.razorpayHttpRequester || razorpayHttpRequester;

        // 2. Atomic concurrency lock with unique worker claimToken
        const STALE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes freshness window
        const staleThreshold = new Date(Date.now() - STALE_TIMEOUT_MS);
        const claimToken = crypto.randomUUID();

        // Derive stable idempotency key (reuses existing key for ambiguous retries)
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
                refundClaimToken: claimToken,
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

        // 3. Razorpay Refund Flow (Guaranteed Provider-Level Idempotency)
        if (claimed.paymentMethod === 'razorpay') {
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

                // Issue authenticated HTTP request with X-Refund-Idempotency header
                const rzpRefund = await executeRazorpayHttp({
                    path: `/payments/${claimed.paymentId}/refund`,
                    method: 'POST',
                    data: refundPayload,
                    headers: {
                        'X-Refund-Idempotency': idempotencyKey
                    }
                }, customRzpHttp);

                if (!rzpRefund || !rzpRefund.id) {
                    await safeDbUpdate(appointmentId, {
                        refundStatus: 'failed',
                        refundClaimedAt: null,
                        refundClaimToken: null,
                        refundFailureReason: 'Razorpay returned empty refund response'
                    }, claimToken);
                    return { success: false, status: 'failed', message: 'Empty refund response from Razorpay' };
                }

                if (rzpRefund.status === 'processed') {
                    try {
                        const updateRes = await safeDbUpdate(appointmentId, {
                            refundStatus: 'refunded',
                            refundId: rzpRefund.id,
                            refundProviderStatus: 'processed',
                            refundAmount: (claimed.paymentAmountMinor / 100),
                            refundAmountMinor: claimed.paymentAmountMinor,
                            refundCurrency: claimed.paymentCurrency,
                            refundedAt: new Date(),
                            refundClaimedAt: null,
                            refundClaimToken: null,
                            refundFailureReason: null
                        }, claimToken);

                        if (updateRes.lostLock) {
                            return {
                                success: false,
                                status: 'stale_worker_aborted',
                                refundId: rzpRefund.id,
                                message: 'Refund was processed by Razorpay but claim lock expired before update could be applied.'
                            };
                        }

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
                        refundClaimToken: null,
                        refundFailureReason: 'Refund pending settlement by Razorpay'
                    }, claimToken);

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
                        refundClaimToken: null,
                        refundFailureReason: `Razorpay reported non-successful status: ${rzpRefund.status}`
                    }, claimToken);

                    return {
                        success: false,
                        status: 'failed',
                        refundId: rzpRefund.id,
                        message: `Razorpay refund status: ${rzpRefund.status}`
                    };
                }
            } catch (rzpErr) {
                return await handleRazorpayFailure(appointmentId, claimed, rzpErr, claimToken, customRzpHttp);
            }
        }

        // 4. Stripe Refund Flow
        if (claimed.paymentMethod === 'stripe') {
            if (!activeStripe) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'failed',
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: 'Stripe client not configured on server'
                }, claimToken);
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
                        refundClaimToken: null,
                        refundFailureReason: 'Stripe returned empty refund response'
                    }, claimToken);
                    return { success: false, status: 'failed', message: 'Empty refund response from Stripe' };
                }

                if (strRefund.status === 'succeeded') {
                    try {
                        const updateRes = await safeDbUpdate(appointmentId, {
                            refundStatus: 'refunded',
                            refundId: strRefund.id,
                            refundProviderStatus: 'succeeded',
                            refundAmount: (claimed.paymentAmountMinor / 100),
                            refundAmountMinor: claimed.paymentAmountMinor,
                            refundCurrency: claimed.paymentCurrency,
                            refundedAt: new Date(),
                            refundClaimedAt: null,
                            refundClaimToken: null,
                            refundFailureReason: null
                        }, claimToken);

                        if (updateRes.lostLock) {
                            return {
                                success: false,
                                status: 'stale_worker_aborted',
                                refundId: strRefund.id,
                                message: 'Refund was processed by Stripe but claim lock expired before update could be applied.'
                            };
                        }

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
                        refundClaimToken: null,
                        refundFailureReason: 'Stripe refund is pending settlement'
                    }, claimToken);

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
                        refundClaimToken: null,
                        refundFailureReason: strRefund.failure_reason || `Stripe reported status: ${strRefund.status}`
                    }, claimToken);

                    return {
                        success: false,
                        status: 'failed',
                        refundId: strRefund.id,
                        message: `Stripe refund status: ${strRefund.status}`
                    };
                }
            } catch (strErr) {
                return await handleStripeFailure(appointmentId, claimed, strErr, activeStripe, claimToken);
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

        const activeStripe = options.stripe || stripeInstance;
        const customRzpHttp = options.razorpayHttpRequester || razorpayHttpRequester;

        // Stripe Reconciliation
        if (appointment.paymentMethod === 'stripe') {
            if (!activeStripe) throw new Error('Stripe client not configured');

            // If appointment already has a specific refundId, verify that exact refund directly
            if (appointment.refundId) {
                try {
                    const exact = await activeStripe.refunds.retrieve(appointment.refundId);
                    if (exact.status === 'succeeded') {
                        await safeDbUpdate(appointmentId, {
                            refundStatus: 'refunded',
                            refundProviderStatus: 'succeeded',
                            refundedAt: new Date(),
                            refundClaimedAt: null,
                            refundClaimToken: null,
                            refundFailureReason: null
                        });
                        return { success: true, status: 'refunded', refundId: exact.id, message: 'Reconciled: exact refund confirmed succeeded on Stripe' };
                    } else if (exact.status === 'pending') {
                        await safeDbUpdate(appointmentId, {
                            refundStatus: 'pending',
                            refundProviderStatus: 'pending',
                            refundClaimedAt: null,
                            refundClaimToken: null
                        });
                        return { success: true, status: 'pending', refundId: exact.id, message: 'Reconciled: exact refund is pending on Stripe' };
                    }
                } catch (retrieveErr) {
                    console.warn(`[reconcileRefund] Stripe retrieve for ${appointment.refundId} failed, falling back to list:`, retrieveErr.message);
                }
            }

            // Fallback: list refunds by payment_intent
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
                    refundClaimToken: null,
                    refundFailureReason: null
                });
                return { success: true, status: 'refunded', refundId: successful.id, message: 'Reconciled: refund confirmed on Stripe' };
            } else if (pending) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'pending',
                    refundId: pending.id,
                    refundProviderStatus: 'pending',
                    refundClaimedAt: null,
                    refundClaimToken: null
                });
                return { success: true, status: 'pending', refundId: pending.id, message: 'Reconciled: refund is pending on Stripe' };
            } else {
                // No refund found on gateway: unlock claim to allow fresh retry
                await safeDbUpdate(appointmentId, {
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: 'Reconciled: No refund found on Stripe. Ready for retry.'
                });
                return { success: true, status: 'no_refund_found', message: 'No refund found on Stripe. Claim released for retry.' };
            }
        }

        // Razorpay Reconciliation
        if (appointment.paymentMethod === 'razorpay') {
            // If appointment already has a specific refundId, verify that exact refund directly
            if (appointment.refundId) {
                try {
                    const exact = await executeRazorpayHttp({
                        path: `/refunds/${appointment.refundId}`,
                        method: 'GET'
                    }, customRzpHttp);

                    if (exact && exact.status === 'processed') {
                        await safeDbUpdate(appointmentId, {
                            refundStatus: 'refunded',
                            refundProviderStatus: 'processed',
                            refundedAt: new Date(),
                            refundClaimedAt: null,
                            refundClaimToken: null,
                            refundFailureReason: null
                        });
                        return { success: true, status: 'refunded', refundId: exact.id, message: 'Reconciled: exact refund confirmed processed on Razorpay' };
                    } else if (exact && exact.status === 'pending') {
                        await safeDbUpdate(appointmentId, {
                            refundStatus: 'pending',
                            refundProviderStatus: 'pending',
                            refundClaimedAt: null,
                            refundClaimToken: null
                        });
                        return { success: true, status: 'pending', refundId: exact.id, message: 'Reconciled: exact refund is pending on Razorpay' };
                    }
                } catch (retrieveErr) {
                    console.warn(`[reconcileRefund] Razorpay retrieve for ${appointment.refundId} failed, falling back to list:`, retrieveErr.message);
                }
            }

            // Fallback: list refunds by payment_id
            const refundsList = await executeRazorpayHttp({
                path: `/payments/${appointment.paymentId}/refunds`,
                method: 'GET'
            }, customRzpHttp);

            const successful = refundsList?.items?.find(r => r.status === 'processed');
            const pending = refundsList?.items?.find(r => r.status === 'pending');

            if (successful) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'refunded',
                    refundId: successful.id,
                    refundProviderStatus: 'processed',
                    refundedAt: new Date(),
                    refundClaimedAt: null,
                    refundClaimToken: null,
                    refundFailureReason: null
                });
                return { success: true, status: 'refunded', refundId: successful.id, message: 'Reconciled: refund confirmed on Razorpay' };
            } else if (pending) {
                await safeDbUpdate(appointmentId, {
                    refundStatus: 'pending',
                    refundId: pending.id,
                    refundProviderStatus: 'pending',
                    refundClaimedAt: null,
                    refundClaimToken: null
                });
                return { success: true, status: 'pending', refundId: pending.id, message: 'Reconciled: refund is pending on Razorpay' };
            } else {
                await safeDbUpdate(appointmentId, {
                    refundClaimedAt: null,
                    refundClaimToken: null,
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
 *
 * Distinguishes:
 * - Ambiguous timeout: reuses existing idempotency key to prevent double refunds.
 * - Confirmed terminal failure: reconciles first to confirm no prior refund is active/successful,
 *   preserves previous attempt in audit trail, and generates an attempt-scoped key.
 */
export const retryFailedRefund = async (appointmentId, options = {}) => {
    const appointment = await appointmentModel.findById(appointmentId);
    if (!appointment) {
        return { success: false, status: 'not_found', message: 'Appointment not found' };
    }

    if (appointment.refundStatus === 'refunded') {
        return { success: true, status: 'already_refunded', message: 'Appointment is already refunded' };
    }

    // Step 1: Reconcile with provider first before generating any new attempt key
    const recon = await reconcileRefund(appointmentId, options);
    if (recon.status === 'refunded') {
        return { success: true, status: 'refunded', refundId: recon.refundId, message: 'Refund was already completed on gateway' };
    }
    if (recon.status === 'pending') {
        return { success: true, status: 'pending', refundId: recon.refundId, message: 'Refund is currently pending settlement on gateway' };
    }

    // Step 2: Confirmed failure handling
    // Audit trail: archive previous failed attempt
    const newAttemptNumber = (appointment.refundAttempts || 0) + 1;
    const historyEntry = {
        attempt: appointment.refundAttempts || 1,
        idempotencyKey: appointment.refundIdempotencyKey,
        refundId: appointment.refundId || null,
        status: appointment.refundStatus,
        failureReason: appointment.refundFailureReason || 'Failed',
        timestamp: new Date()
    };

    // Scoped new attempt key allows genuine re-attempt with provider (bypasses 24h failure cache)
    const newAttemptKey = `ref_${appointment._id.toString()}_attempt_${newAttemptNumber}`;

    await appointmentModel.findByIdAndUpdate(appointmentId, {
        $set: {
            refundStatus: 'pending',
            refundId: null,
            refundIdempotencyKey: newAttemptKey,
            refundClaimedAt: null,
            refundClaimToken: null,
            refundFailureReason: 'Admin retry requested after confirmed terminal failure'
        },
        $push: {
            refundPreviousAttempts: historyEntry
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
