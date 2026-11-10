import React, { useState, useContext } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { AppContext } from '../context/AppContext'
import { assets } from '../assets/assets'

const DoctorRecommendation = () => {
    const { backendUrl, currencySymbol } = useContext(AppContext)
    const navigate = useNavigate()

    const [concern, setConcern] = useState('')
    const [budget, setBudget] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState(null)
    const [result, setResult] = useState(null)

    const handleSubmit = async (e) => {
        e.preventDefault()

        if (!concern.trim()) {
            setError('Please describe your symptoms or health concern.')
            return
        }

        if (concern.trim().length < 5) {
            setError('Please describe your concern with at least 5 characters.')
            return
        }

        setLoading(true)
        setError(null)
        setResult(null)

        try {
            const payload = { concern: concern.trim() }
            if (budget && Number(budget) > 0) {
                payload.budget = Number(budget)
            }

            const { data } = await axios.post(`${backendUrl}/api/recommendation/find-doctors`, payload)

            if (data.success) {
                setResult(data)
            } else {
                setError(data.message || 'Unable to retrieve doctor recommendations.')
            }
        } catch (err) {
            console.error('Recommendation API error:', err)
            setError(err.response?.data?.message || 'Server error while fetching recommendations. Please try again.')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className='w-full max-w-5xl mx-auto py-6 sm:py-10 px-2'>
            {/* Header */}
            <div className='text-center mb-8'>
                <span className='px-3 py-1 bg-primary/10 text-primary rounded-full text-xs font-semibold tracking-wide uppercase'>
                    AI Smart Triage
                </span>
                <h1 className='text-2xl sm:text-4xl font-semibold text-gray-800 mt-3'>
                    Find the Right Doctor for Your Needs
                </h1>
                <p className='text-gray-500 text-sm sm:text-base mt-2 max-w-2xl mx-auto'>
                    Describe your symptoms or health concerns in plain language. Our system helps match you with verified, available specialists.
                </p>
            </div>

            {/* Medical Disclaimer Banner */}
            <div className='bg-amber-50 border-l-4 border-amber-400 p-4 rounded-r-lg mb-8 text-amber-900 text-xs sm:text-sm flex items-start gap-3'>
                <span className='text-lg'>ℹ️</span>
                <div>
                    <p className='font-semibold'>Important Medical Notice</p>
                    <p className='text-amber-800 mt-0.5'>
                        This tool helps you find a relevant doctor. It does not provide medical diagnosis or medical advice.
                    </p>
                </div>
            </div>

            {/* Input Form Card */}
            <form onSubmit={handleSubmit} className='bg-white border border-gray-200 rounded-2xl shadow-sm p-6 sm:p-8 mb-10'>
                <div className='mb-5'>
                    <label className='block text-sm font-semibold text-gray-700 mb-2'>
                        Describe your health concern <span className='text-rose-500'>*</span>
                    </label>
                    <textarea
                        rows='4'
                        value={concern}
                        onChange={(e) => setConcern(e.target.value)}
                        placeholder="e.g., I have been experiencing severe throbbing headaches on the right side with light sensitivity and mild nausea for the past 2 days..."
                        className='w-full border border-gray-300 rounded-xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all resize-none text-gray-800'
                        maxLength='1000'
                    />
                    <div className='flex justify-between items-center text-xs text-gray-400 mt-1.5 px-1'>
                        <span>Be as specific as possible about timing, severity, or location.</span>
                        <span>{concern.length}/1000</span>
                    </div>
                </div>

                <div className='flex flex-col sm:flex-row items-center gap-4 pt-2'>
                    <div className='w-full sm:w-1/2'>
                        <label className='block text-xs font-semibold text-gray-600 mb-1.5'>
                            Preferred Max Consultation Fee ({currencySymbol}) <span className='text-gray-400 font-normal'>(Optional)</span>
                        </label>
                        <input
                            type='number'
                            min='0'
                            value={budget}
                            onChange={(e) => setBudget(e.target.value)}
                            placeholder='e.g., 500'
                            className='w-full border border-gray-300 rounded-lg px-3.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-all'
                        />
                    </div>

                    <div className='w-full sm:w-1/2 sm:self-end'>
                        <button
                            type='submit'
                            disabled={loading || !concern.trim()}
                            className='w-full py-2.5 px-6 rounded-lg bg-primary hover:bg-primary/90 text-white font-medium text-sm transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2'
                        >
                            {loading ? (
                                <>
                                    <span className='w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin'></span>
                                    <span>Analyzing Concern...</span>
                                </>
                            ) : (
                                <>
                                    <span>🔍</span>
                                    <span>Get Recommendations</span>
                                </>
                            )}
                        </button>
                    </div>
                </div>

                {error && (
                    <div className='mt-4 p-3.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs sm:text-sm rounded-lg flex items-center gap-2'>
                        <span>⚠️</span>
                        <span>{error}</span>
                    </div>
                )}
            </form>

            {/* Results Section */}
            {result && (
                <div className='space-y-8 animate-fadeIn'>
                    {/* Emergency Warning State */}
                    {result.classification?.isEmergency && (
                        <div className='bg-rose-50 border-2 border-rose-400 rounded-xl p-5 text-rose-900 shadow-sm'>
                            <div className='flex items-center gap-3 mb-2'>
                                <span className='text-2xl'>🚨</span>
                                <h3 className='font-bold text-base sm:text-lg text-rose-800'>Urgent Medical Attention Required</h3>
                            </div>
                            <p className='text-sm text-rose-800 leading-relaxed font-medium'>
                                {result.classification.urgencyMessage || "Your symptoms may require urgent medical attention. Please contact your local emergency number or visit the nearest emergency department immediately."}
                            </p>
                            <p className='text-xs text-rose-600 mt-2 italic'>
                                Note: Routine online appointments are not a substitute for emergency department care in acute or life-threatening situations.
                            </p>
                        </div>
                    )}

                    {/* AI / Fallback Speciality Classification Summary */}
                    {result.classification && (
                        <div className='bg-indigo-50/70 border border-indigo-200 rounded-xl p-5'>
                            <div className='flex flex-wrap items-center justify-between gap-3'>
                                <div>
                                    <div className='flex items-center gap-2'>
                                        <span className='text-xs font-semibold uppercase tracking-wider text-indigo-700'>
                                            Target Medical Speciality:
                                        </span>
                                        {result.classification.source === 'ai' && (
                                            <span className='text-[10px] bg-indigo-200 text-indigo-800 px-2 py-0.5 rounded-full font-medium'>
                                                AI Assisted
                                            </span>
                                        )}
                                    </div>
                                    <div className='flex flex-wrap items-center gap-2 mt-1.5'>
                                        {result.classification.matchedSpecialities.map((spec, sIdx) => (
                                            <span key={sIdx} className='px-3 py-1 bg-white border border-indigo-300 text-indigo-900 font-semibold rounded-lg text-sm shadow-sm'>
                                                {spec}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <p className='text-xs sm:text-sm text-indigo-950/80 mt-3 border-t border-indigo-100 pt-2.5'>
                                {result.classification.explanation}
                            </p>
                        </div>
                    )}

                    {/* Recommended Doctors List */}
                    <div>
                        <div className='flex items-center justify-between mb-4'>
                            <h2 className='text-lg sm:text-xl font-semibold text-gray-800'>
                                Recommended Specialists ({result.recommendedDoctors?.length || 0})
                            </h2>
                            <span className='text-xs text-gray-500'>
                                Ranked by speciality match, rating, experience & availability
                            </span>
                        </div>

                        {(!result.recommendedDoctors || result.recommendedDoctors.length === 0) ? (
                            <div className='bg-white border border-gray-200 rounded-2xl p-10 text-center text-gray-500'>
                                <p className='text-base font-medium mb-1'>No matching specialists currently available.</p>
                                <p className='text-xs text-gray-400 mb-4'>
                                    Try adjusting your budget or browse our complete directory of trusted doctors.
                                </p>
                                <button
                                    onClick={() => navigate('/doctors')}
                                    className='px-5 py-2 bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary/90 transition-all'
                                >
                                    Browse All Doctors
                                </button>
                            </div>
                        ) : (
                            <div className='grid grid-cols-1 md:grid-cols-2 gap-5'>
                                {result.recommendedDoctors.map((doc, idx) => (
                                    <div
                                        key={doc._id || idx}
                                        className='bg-white border border-gray-200 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all flex flex-col justify-between border-t-4 border-t-primary'
                                    >
                                        <div>
                                            {/* Rank Badge & Match Rationale */}
                                            <div className='flex items-center justify-between mb-3 text-xs'>
                                                <span className='px-2 py-0.5 bg-primary/10 text-primary font-bold rounded-md'>
                                                    #{idx + 1} Best Match
                                                </span>
                                                <span className='text-gray-400 font-medium'>
                                                    Score: {Math.round(doc.recommendationScore * 100)}%
                                                </span>
                                            </div>

                                            {/* Doctor Info Row */}
                                            <div className='flex items-start gap-4'>
                                                <img
                                                    src={doc.image || assets.profile_pic}
                                                    alt={doc.name}
                                                    className='w-16 h-16 rounded-xl object-cover bg-gray-100 border'
                                                />
                                                <div className='flex-1 min-w-0'>
                                                    <h3 className='text-base font-semibold text-gray-900 truncate'>
                                                        {doc.name}
                                                    </h3>
                                                    <p className='text-xs text-primary font-medium'>
                                                        {doc.speciality} &bull; <span className='text-gray-500'>{doc.degree}</span>
                                                    </p>
                                                    <p className='text-xs text-gray-500 mt-0.5'>
                                                        {doc.experience || 'Experienced practitioner'}
                                                    </p>
                                                    
                                                    {/* Rating & Fee badges */}
                                                    <div className='flex flex-wrap items-center gap-2 mt-2'>
                                                        <span className='inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 rounded-md font-medium'>
                                                            ★ {doc.averageRating > 0 ? doc.averageRating.toFixed(1) : 'New'}
                                                            <span className='text-amber-500'>({doc.reviewCount || 0})</span>
                                                        </span>
                                                        <span className='text-xs px-2 py-0.5 bg-gray-50 text-gray-700 border border-gray-200 rounded-md font-medium'>
                                                            {currencySymbol}{doc.fees} Consultation
                                                        </span>
                                                        {doc.hasUpcomingSlots && (
                                                            <span className='text-[10px] px-2 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md font-medium'>
                                                                ● Slots Open
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Match Reason Pill */}
                                            {doc.whyRecommended && (
                                                <div className='mt-3.5 pt-3 border-t border-gray-100 text-xs text-gray-600 bg-gray-50/60 p-2.5 rounded-lg'>
                                                    <span className='font-semibold text-gray-700'>Why matched: </span>
                                                    {doc.whyRecommended}
                                                </div>
                                            )}
                                        </div>

                                        {/* Action Button */}
                                        <div className='mt-4 pt-3 border-t border-gray-100 flex items-center justify-between gap-3'>
                                            <button
                                                onClick={() => {
                                                    navigate(`/appointment/${doc._id}`)
                                                    window.scrollTo(0, 0)
                                                }}
                                                className='w-full py-2 bg-primary hover:bg-primary/90 text-white rounded-lg text-xs font-semibold transition-all shadow hover:shadow-md flex items-center justify-center gap-1.5'
                                            >
                                                <span>📅</span> Book Consultation
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

export default DoctorRecommendation
