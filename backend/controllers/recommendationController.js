import doctorModel from "../models/doctorModel.js"
import { classifyHealthConcern } from "../services/aiRecommendationService.js"

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Checks whether a doctor has open slots in the next 7 days based on working hours and slots_booked
 */
export const checkDoctorUpcomingAvailability = (doctor, daysAhead = 7) => {
    if (!doctor || doctor.available === false) {
        return { hasSlots: false, nextAvailableDate: null }
    }

    try {
        const slotsBooked = doctor.slots_booked || {}
        const daysOff = Array.isArray(doctor.daysOff) ? doctor.daysOff : ['Sunday']
        const workingStart = doctor.workingHours?.start || '10:00 AM'
        const workingEnd = doctor.workingHours?.end || '07:00 PM'

        const now = new Date()

        for (let i = 0; i < daysAhead; i++) {
            const currentDate = new Date(now)
            currentDate.setDate(now.getDate() + i)

            const dayName = DAYS_OF_WEEK[currentDate.getDay()]
            if (daysOff.includes(dayName)) {
                continue
            }

            const day = currentDate.getDate()
            const month = currentDate.getMonth() + 1
            const year = currentDate.getFullYear()
            const slotDateKey = `${day}_${month}_${year}`
            const bookedForDay = slotsBooked[slotDateKey] || []

            // If day is not completely booked, verify at least one theoretical slot exists
            // Standard clinic schedule: 10:00 AM to 07:00 PM (approx 18 thirty-minute slots)
            const approxTotalDailySlots = 18
            if (bookedForDay.length < approxTotalDailySlots) {
                return { hasSlots: true, nextAvailableDate: slotDateKey }
            }
        }

        return { hasSlots: false, nextAvailableDate: null }
    } catch {
        return { hasSlots: Boolean(doctor.available), nextAvailableDate: null }
    }
}

/**
 * Normalizes doctor rating using Bayesian smoothing so doctors with 0 reviews
 * are neither penalized as 0 nor treated as 5-star verified doctors.
 */
export const calculateNormalizedRating = (averageRating = 0, reviewCount = 0) => {
    const priorRating = 3.0 // Platform neutral baseline
    const priorWeight = 2   // Equivalent to 2 baseline reviews
    const smoothed = (averageRating * reviewCount + priorRating * priorWeight) / (reviewCount + priorWeight)
    return Math.min(1.0, Math.max(0.0, smoothed / 5.0))
}

/**
 * Extracts and normalizes clinical experience years safely
 */
export const calculateNormalizedExperience = (experienceStr) => {
    if (!experienceStr) return 0.1
    const match = experienceStr.toString().match(/\d+/)
    const years = match ? parseInt(match[0], 10) : 1
    return Math.min(1.0, Math.max(0.05, years / 20.0)) // Max out at 20 years
}

/**
 * Calculates budget alignment score
 */
export const calculateBudgetScore = (doctorFees, patientBudget) => {
    if (!patientBudget || patientBudget <= 0) {
        return 1.0 // Neutral score: do not penalize doctor if patient specified no budget
    }
    const fees = Number(doctorFees) || 0
    if (fees <= patientBudget) {
        // Within budget: reward lower fees slightly
        return Math.min(1.0, 1.0 - (fees / patientBudget) * 0.2)
    } else {
        // Exceeds budget: decay smoothly
        const overage = fees - patientBudget
        return Math.max(0.0, 1.0 - (overage / patientBudget))
    }
}

/**
 * Main Controller: POST /api/recommendation/find-doctors
 */
export const getDoctorRecommendations = async (req, res) => {
    try {
        const { concern, budget, allowExternalAI = false } = req.body || {}

        // Input validation
        if (!concern || typeof concern !== 'string') {
            return res.status(400).json({
                success: false,
                message: "Please provide a description of your health concern."
            })
        }

        const trimmedConcern = concern.trim()
        if (trimmedConcern.length < 5) {
            return res.status(400).json({
                success: false,
                message: "Please describe your symptoms in at least 5 characters for an accurate recommendation."
            })
        }

        if (trimmedConcern.length > 1000) {
            return res.status(400).json({
                success: false,
                message: "Health concern description is too long (maximum 1000 characters)."
            })
        }

        const parsedBudget = budget && !isNaN(Number(budget)) && Number(budget) > 0
            ? Number(budget)
            : null

        // Step 1: Classify concern via AI or local privacy fallback
        const classification = await classifyHealthConcern(trimmedConcern, {
            allowExternalAI: Boolean(allowExternalAI)
        })
        const primarySpeciality = classification.matchedSpecialities[0] || 'General physician'
        const secondarySpeciality = classification.matchedSpecialities[1] || null

        // Step 1.5: Emergency safety boundary
        // Do not present ordinary doctor rankings as an alternative to emergency care
        if (classification.isEmergency) {
            return res.json({
                success: true,
                classification: {
                    matchedSpecialities: classification.matchedSpecialities,
                    explanation: classification.explanation,
                    isVague: classification.isVague,
                    isEmergency: true,
                    urgencyMessage: classification.urgencyMessage,
                    source: classification.source
                },
                recommendedDoctors: [],
                totalFound: 0,
                message: "Potential medical emergency detected. Please seek emergency medical care immediately."
            })
        }

        // Step 2: Query candidate doctors from MongoDB
        // Only select approved doctors matching the target specialities
        const targetSpecialities = classification.matchedSpecialities
        const candidateDoctors = await doctorModel.find({
            isApproved: { $ne: false },
            speciality: { $in: targetSpecialities }
        }).select('-password -email')

        // If database has 0 eligible doctors matching the target specialities, return honest empty state
        // Do NOT silently fall back to unrelated General Physicians
        if (candidateDoctors.length === 0) {
            return res.json({
                success: true,
                classification: {
                    matchedSpecialities: classification.matchedSpecialities,
                    explanation: classification.explanation,
                    isVague: classification.isVague,
                    isEmergency: classification.isEmergency,
                    urgencyMessage: classification.urgencyMessage,
                    source: classification.source
                },
                recommendedDoctors: [],
                totalFound: 0,
                message: "No doctors currently match your criteria. Please check back later or browse all doctors."
            })
        }

        // Step 3: Multi-Factor Deterministic Scoring & Ranking
        const scoredDoctors = candidateDoctors.map((doc) => {
            const docObj = doc.toObject ? doc.toObject() : doc

            // Factor 1: Speciality Relevance (40%)
            let relevanceScore = 0.4
            if (docObj.speciality === primarySpeciality) {
                relevanceScore = 1.0
            } else if (docObj.speciality === secondarySpeciality) {
                relevanceScore = 0.75
            }

            // Factor 2: Platform & Slot Availability (20%)
            // Fully booked doctors (no slots in next 7 days) receive 0.0 availability score
            const availCheck = checkDoctorUpcomingAvailability(docObj)
            let availScore = 0.0
            if (docObj.available !== false && availCheck.hasSlots) {
                availScore = 1.0
            } else {
                availScore = 0.0
            }

            // Factor 3: Patient Rating (20%)
            const ratingScore = calculateNormalizedRating(docObj.averageRating, docObj.reviewCount)

            // Factor 4: Clinical Experience (10%)
            const expScore = calculateNormalizedExperience(docObj.experience)

            // Factor 5: Fee Budget Alignment (10%)
            const budgetScore = calculateBudgetScore(docObj.fees, parsedBudget)

            // Total Weighted Score (0.0 to 1.0)
            const totalScore = (
                (relevanceScore * 0.40) +
                (availScore * 0.20) +
                (ratingScore * 0.20) +
                (expScore * 0.10) +
                (budgetScore * 0.10)
            )

            // Generate personalized, non-diagnostic matching rationale
            const reasons = []
            if (relevanceScore === 1.0) {
                reasons.push(`Direct specialist in ${docObj.speciality}`)
            } else {
                reasons.push(`Experienced in ${docObj.speciality}`)
            }

            if (!availCheck.hasSlots) {
                reasons.push("Fully booked for the next 7 days")
            } else {
                reasons.push("Open slots available this week")
            }

            if (docObj.experience) {
                reasons.push(`${docObj.experience} clinical experience`)
            }

            if (docObj.reviewCount > 0 && docObj.averageRating >= 4.0) {
                reasons.push(`Highly rated (${docObj.averageRating}★ from ${docObj.reviewCount} patients)`)
            }

            if (parsedBudget && docObj.fees <= parsedBudget) {
                reasons.push("Within your preferred consultation budget")
            }

            return {
                ...docObj,
                recommendationScore: Math.round(totalScore * 100) / 100,
                hasUpcomingSlots: availCheck.hasSlots,
                isFullyBooked: !availCheck.hasSlots,
                whyRecommended: reasons.slice(0, 4).join(" • ")
            }
        })

        // Sort descending by recommendation score
        scoredDoctors.sort((a, b) => b.recommendationScore - a.recommendationScore)

        // Select top 3 to 5 doctors
        const topDoctors = scoredDoctors.slice(0, 5)

        res.json({
            success: true,
            classification: {
                matchedSpecialities: classification.matchedSpecialities,
                explanation: classification.explanation,
                isVague: classification.isVague,
                isEmergency: classification.isEmergency,
                urgencyMessage: classification.urgencyMessage,
                source: classification.source
            },
            recommendedDoctors: topDoctors,
            totalFound: topDoctors.length
        })

    } catch (error) {
        console.error("[recommendationController] Error in getDoctorRecommendations:", error.message)
        res.status(500).json({
            success: false,
            message: "Unable to complete doctor recommendation at this time. Please try again."
        })
    }
}

export default {
    checkDoctorUpcomingAvailability,
    calculateNormalizedRating,
    calculateNormalizedExperience,
    calculateBudgetScore,
    getDoctorRecommendations
}
