/**
 * Prescripto AI Doctor Recommendation Service
 * 
 * Hybrid architecture:
 * - Natural-language concern understanding and speciality classification via AI (with local fallback).
 * - Strict non-diagnostic safety boundaries (administrative doctor triage only).
 * - Zero patient PII transmission; zero persistence of raw symptom text.
 */

export const ALLOWED_SPECIALITIES = [
    'General physician',
    'Gynecologist',
    'Dermatologist',
    'Pediatricians',
    'Neurologist',
    'Gastroenterologist'
];

export const EMERGENCY_WARNING_MESSAGE =
    "Your symptoms may require urgent medical attention. Please contact your local emergency number or visit the nearest emergency department immediately.";

// Conservative local emergency red-flag patterns
export const EMERGENCY_PATTERNS = [
    /\b(chest pain|heart attack|angina|crushing chest|pressure in chest|radiating to (arm|jaw|neck|back))\b/i,
    /\b(difficulty breathing|can't breathe|cannot breathe|suffocating|severe shortness of breath|gasping for air)\b/i,
    /\b(stroke|facial droop|slurred speech|sudden weakness|sudden numbness|loss of speech|arm drift)\b/i,
    /\b(coughing blood|vomiting blood|severe hemorrhage|uncontrolled bleeding)\b/i,
    /\b(unconscious|passed out|loss of consciousness|unresponsive|blacked out|seizure|convulsions)\b/i,
    /\b(severe head injury|major trauma|sudden severe confusion|anaphylaxis|throat swelling|unable to swallow)\b/i,
    /\b(suicidal|end my life|kill myself|want to die)\b/i
];

/**
 * Checks if the text exhibits severe red-flag emergency symptoms
 */
export const checkEmergencyRedFlags = (text) => {
    if (!text || typeof text !== 'string') return false;
    return EMERGENCY_PATTERNS.some(regex => regex.test(text));
};

// Local keyword taxonomy mapping for fallback and offline resilience
export const KEYWORD_SPECIALITY_MAP = [
    {
        speciality: 'Neurologist',
        keywords: [
            'headache', 'migraine', 'dizziness', 'vertigo', 'seizure', 'epilepsy', 'numbness',
            'tingling', 'tremor', 'memory loss', 'neuropathy', 'nerve pain', 'concussion',
            'neuralgia', 'paralysis', 'coordination', 'lightheaded', 'fainting'
        ]
    },
    {
        speciality: 'Dermatologist',
        keywords: [
            'skin', 'rash', 'acne', 'itching', 'itchy', 'eczema', 'psoriasis', 'hives',
            'mole', 'spots', 'blister', 'dermatitis', 'hair loss', 'scalp', 'dandruff',
            'fungal', 'ringworm', 'wart', 'nail infection', 'sunburn', 'dry skin', 'pigmentation'
        ]
    },
    {
        speciality: 'Pediatricians',
        keywords: [
            'child', 'baby', 'infant', 'toddler', 'kid', 'newborn', 'pediatric', 'pediatrician',
            'vaccination', 'growth', 'milestones', 'diaper rash', 'croup', 'colic', 'bedwetting',
            'teething', 'son', 'daughter'
        ]
    },
    {
        speciality: 'Gynecologist',
        keywords: [
            'pregnancy', 'pregnant', 'period', 'menstrual', 'menstruation', 'pcos', 'pcod',
            'ovary', 'uterus', 'vaginal', 'pelvic pain', 'cramps', 'contraception', 'fertility',
            'miscarriage', 'menopause', 'pap smear', 'breast lump', 'gynecology', 'endometriosis'
        ]
    },
    {
        speciality: 'Gastroenterologist',
        keywords: [
            'stomach', 'abdomen', 'abdominal', 'belly', 'digestion', 'indigestion', 'acid reflux',
            'heartburn', 'gerd', 'nausea', 'vomiting', 'diarrhea', 'constipation', 'bloating',
            'gas', 'liver', 'gallbladder', 'ulcer', 'gastritis', 'ibs', 'stool', 'bowel', 'cramping'
        ]
    },
    {
        speciality: 'General physician',
        keywords: [
            'fever', 'cough', 'cold', 'flu', 'sore throat', 'fatigue', 'weakness', 'tired',
            'infection', 'blood pressure', 'hypertension', 'diabetes', 'sugar', 'cholesterol',
            'weight loss', 'weight gain', 'chills', 'body ache', 'malaise', 'routine checkup'
        ]
    }
];

/**
 * Deterministic local keyword fallback classification
 */
export const classifyConcernFallback = (concernText) => {
    const text = (concernText || '').toLowerCase().trim();
    const isEmergency = checkEmergencyRedFlags(text);

    if (text.length < 8) {
        return {
            matchedSpecialities: ['General physician'],
            explanation: "Your description is very brief. A General physician can perform an initial assessment, or you can provide more details for a more targeted match.",
            isVague: true,
            isEmergency,
            urgencyMessage: isEmergency ? EMERGENCY_WARNING_MESSAGE : null,
            source: 'fallback'
        };
    }

    // Score specialities based on keyword frequency and clinical context
    const scores = [];
    for (const entry of KEYWORD_SPECIALITY_MAP) {
        let matchCount = 0;
        for (const kw of entry.keywords) {
            // Whole word or boundary match
            const regex = new RegExp(`\\b${kw}`, 'i');
            if (regex.test(text)) {
                // High-significance demographic context keywords (e.g. child, infant) count with weight 2
                if (entry.speciality === 'Pediatricians' && ['child', 'baby', 'infant', 'toddler', 'kid', 'newborn', 'pediatric'].includes(kw)) {
                    matchCount += 2;
                } else {
                    matchCount += 1;
                }
            }
        }
        if (matchCount > 0) {
            scores.push({ speciality: entry.speciality, count: matchCount });
        }
    }

    scores.sort((a, b) => b.count - a.count);

    if (scores.length === 0) {
        return {
            matchedSpecialities: ['General physician'],
            explanation: "Based on your description, a General physician is recommended for an initial comprehensive assessment.",
            isVague: true,
            isEmergency,
            urgencyMessage: isEmergency ? EMERGENCY_WARNING_MESSAGE : null,
            source: 'fallback'
        };
    }

    const matchedSpecialities = [scores[0].speciality];
    if (scores.length > 1 && (scores[1].count >= Math.ceil(scores[0].count * 0.5) || scores[0].count <= 2)) {
        matchedSpecialities.push(scores[1].speciality);
    }

    return {
        matchedSpecialities,
        explanation: `Recommended based on symptoms related to ${matchedSpecialities.join(' and ')}.`,
        isVague: false,
        isEmergency,
        urgencyMessage: isEmergency ? EMERGENCY_WARNING_MESSAGE : null,
        source: 'fallback'
    };
};

/**
 * Validates AI JSON response against strict platform contract
 */
export const validateAiClassificationResponse = (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;

    let matched = parsed.matchedSpecialities;
    if (!Array.isArray(matched)) return null;

    // Filter to only allowed specialities
    matched = matched.filter(s => ALLOWED_SPECIALITIES.includes(s));
    if (matched.length === 0) return null;

    // Limit to max 2
    matched = matched.slice(0, 2);

    const explanation = typeof parsed.explanation === 'string' && parsed.explanation.trim().length > 0
        ? parsed.explanation.trim()
        : `Recommended based on matched speciality: ${matched.join(', ')}.`;

    const isVague = Boolean(parsed.isVague);
    const isEmergency = Boolean(parsed.isEmergency);

    return {
        matchedSpecialities: matched,
        explanation,
        isVague,
        isEmergency,
        urgencyMessage: isEmergency ? EMERGENCY_WARNING_MESSAGE : null,
        source: 'ai'
    };
};

/**
 * Classifies health concern using external AI model with seamless local fallback
 */
export const classifyHealthConcern = async (concernText) => {
    // 1. Check local emergency triggers first
    const localEmergency = checkEmergencyRedFlags(concernText);

    // 2. Identify API configuration
    const apiKey = process.env.GEMINI_API_KEY || process.env.AI_API_KEY;
    const model = process.env.AI_MODEL || process.env.GEMINI_MODEL || "gemini-1.5-flash";

    // If no API key configured, use local fallback
    if (!apiKey) {
        const fallbackResult = classifyConcernFallback(concernText);
        if (localEmergency) {
            fallbackResult.isEmergency = true;
            fallbackResult.urgencyMessage = EMERGENCY_WARNING_MESSAGE;
        }
        return fallbackResult;
    }

    // 3. Attempt external AI classification with strict prompt engineering
    try {
        const apiUrl = process.env.AI_API_URL ||
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        const systemInstruction = `You are a medical administrative triaging assistant for the Prescripto healthcare platform.
Your ONLY role is to map the user's described health concern to one or two supported medical specialities.
You MUST NOT diagnose illnesses, prescribe medication, recommend medical treatments, or interpret laboratory tests.
Allowed specialities (YOU MUST USE ONLY THESE EXACT NAMES):
- General physician
- Gynecologist
- Dermatologist
- Pediatricians
- Neurologist
- Gastroenterologist

OUTPUT FORMAT: Return strictly valid JSON with no markdown formatting or extra text:
{
  "matchedSpecialities": ["Speciality1"],
  "explanation": "Short non-diagnostic reason why this specialist is relevant",
  "isVague": false,
  "isEmergency": false
}`;

        // Patient input is treated strictly as data to prevent prompt injection
        const promptText = `Analyze the following health concern for doctor triage:\n"${concernText.slice(0, 1000)}"`;

        const requestBody = {
            contents: [
                {
                    role: "user",
                    parts: [{ text: `${systemInstruction}\n\n${promptText}` }]
                }
            ],
            generationConfig: {
                temperature: 0.1,
                maxOutputTokens: 250,
                responseMimeType: "application/json"
            }
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

        const response = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(requestBody),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`[aiRecommendationService] AI API returned status ${response.status}. Using fallback.`);
            const fallbackResult = classifyConcernFallback(concernText);
            if (localEmergency) {
                fallbackResult.isEmergency = true;
                fallbackResult.urgencyMessage = EMERGENCY_WARNING_MESSAGE;
            }
            return fallbackResult;
        }

        const data = await response.json();
        const rawContent = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawContent) {
            throw new Error("Empty AI response content");
        }

        // Clean any accidental markdown backticks
        const cleanedJson = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(cleanedJson);

        const validated = validateAiClassificationResponse(parsed);
        if (!validated) {
            console.warn("[aiRecommendationService] AI response failed schema validation. Using fallback.");
            const fallbackResult = classifyConcernFallback(concernText);
            if (localEmergency) {
                fallbackResult.isEmergency = true;
                fallbackResult.urgencyMessage = EMERGENCY_WARNING_MESSAGE;
            }
            return fallbackResult;
        }

        if (localEmergency) {
            validated.isEmergency = true;
            validated.urgencyMessage = EMERGENCY_WARNING_MESSAGE;
        }

        return validated;

    } catch (err) {
        console.warn(`[aiRecommendationService] AI request error: ${err.message}. Using fallback.`);
        const fallbackResult = classifyConcernFallback(concernText);
        if (localEmergency) {
            fallbackResult.isEmergency = true;
            fallbackResult.urgencyMessage = EMERGENCY_WARNING_MESSAGE;
        }
        return fallbackResult;
    }
};

export default {
    ALLOWED_SPECIALITIES,
    EMERGENCY_WARNING_MESSAGE,
    checkEmergencyRedFlags,
    classifyConcernFallback,
    validateAiClassificationResponse,
    classifyHealthConcern
};
