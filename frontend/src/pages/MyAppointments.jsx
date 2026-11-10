import React, { useContext, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AppContext } from '../context/AppContext'
import axios from 'axios'
import { toast } from 'react-toastify'
import { assets } from '../assets/assets'
import ChatModal from '../components/ChatModal'
import VideoConsultationModal from '../components/VideoConsultationModal'

const MyAppointments = () => {

    const { backendUrl, token } = useContext(AppContext)
    const navigate = useNavigate()

    const [appointments, setAppointments] = useState([])
    const [payment, setPayment] = useState('')
    const [reviewingId, setReviewingId] = useState('')
    const [ratingValue, setRatingValue] = useState(5)
    const [comment, setComment] = useState('')

    // Reschedule states
    const [reschedulingId, setReschedulingId] = useState('')
    const [rescheduleDate, setRescheduleDate] = useState('')
    const [rescheduleTime, setRescheduleTime] = useState('10:00 AM')
    const [selectedPrescription, setSelectedPrescription] = useState(null)
    const [chattingAppointment, setChattingAppointment] = useState(null)
    const [videoAppointment, setVideoAppointment] = useState(null)

    const timeSlots = ["10:00 AM", "11:00 AM", "12:00 PM", "02:00 PM", "03:00 PM", "04:00 PM", "05:00 PM", "06:00 PM", "07:00 PM"]

    const handleReschedule = async (appointmentId) => {
        if (!rescheduleDate || !rescheduleTime) {
            return toast.error("Please select a new date and time slot")
        }
        try {
            // format date string eg 2026-11-10 to 10_11_2026
            const dateParts = rescheduleDate.split('-')
            const formattedSlotDate = `${Number(dateParts[2])}_${Number(dateParts[1])}_${dateParts[0]}`

            const { data } = await axios.post(
                backendUrl + '/api/user/reschedule-appointment',
                { appointmentId, newSlotDate: formattedSlotDate, newSlotTime: rescheduleTime },
                { headers: { token } }
            )

            if (data.success) {
                toast.success(data.message)
                setReschedulingId('')
                setRescheduleDate('')
                getUserAppointments()
            } else {
                toast.error(data.message)
            }
        } catch (error) {
            toast.error(error.response?.data?.message || error.message)
        }
    }

    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    // Function to format the date eg. ( 20_01_2000 => 20 Jan 2000 )
    const slotDateFormat = (slotDate) => {
        const dateArray = slotDate.split('_')
        return dateArray[0] + " " + months[Number(dateArray[1])] + " " + dateArray[2]
    }

    // Getting User Appointments Data Using API
    const getUserAppointments = async () => {
        try {

            const { data } = await axios.get(backendUrl + '/api/user/appointments', { headers: { token } })
            setAppointments(data.appointments.reverse())

        } catch (error) {
            console.log(error)
            toast.error(error.message)
        }
    }

    // Function to cancel appointment Using API
    const cancelAppointment = async (appointmentId) => {

        try {

            const { data } = await axios.post(backendUrl + '/api/user/cancel-appointment', { appointmentId }, { headers: { token } })

            if (data.success) {
                toast.success(data.message)
                getUserAppointments()
            } else {
                toast.error(data.message)
            }

        } catch (error) {
            console.log(error)
            toast.error(error.message)
        }

    }

    const initPay = (order) => {
        const options = {
            key: import.meta.env.VITE_RAZORPAY_KEY_ID,
            amount: order.amount,
            currency: order.currency,
            name: 'Appointment Payment',
            description: "Appointment Payment",
            order_id: order.id,
            receipt: order.receipt,
            handler: async (response) => {

                console.log(response)

                try {
                    const { data } = await axios.post(backendUrl + "/api/user/verifyRazorpay", response, { headers: { token } });
                    if (data.success) {
                        navigate('/my-appointments')
                        getUserAppointments()
                    }
                } catch (error) {
                    console.log(error)
                    toast.error(error.message)
                }
            }
        };
        const rzp = new window.Razorpay(options);
        rzp.open();
    };

    // Function to submit a review for a completed appointment
    const submitReview = async (appointmentId) => {
        try {
            const { data } = await axios.post(backendUrl + '/api/user/add-review', { appointmentId, rating: ratingValue, comment }, { headers: { token } })
            if (data.success) {
                toast.success(data.message)
                setReviewingId('')
                setComment('')
                setRatingValue(5)
            } else {
                toast.error(data.message)
            }
        } catch (error) {
            console.log(error)
            toast.error(error.message)
        }
    }

    // Function to make payment using razorpay
    const appointmentRazorpay = async (appointmentId) => {
        try {
            const { data } = await axios.post(backendUrl + '/api/user/payment-razorpay', { appointmentId }, { headers: { token } })
            if (data.success) {
                initPay(data.order)
            }else{
                toast.error(data.message)
            }
        } catch (error) {
            console.log(error)
            toast.error(error.message)
        }
    }

    // Function to make payment using stripe
    const appointmentStripe = async (appointmentId) => {
        try {
            const { data } = await axios.post(backendUrl + '/api/user/payment-stripe', { appointmentId }, { headers: { token } })
            if (data.success) {
                const { session_url } = data
                window.location.replace(session_url)
            }else{
                toast.error(data.message)
            }
        } catch (error) {
            console.log(error)
            toast.error(error.message)
        }
    }



    useEffect(() => {
        if (token) {
            getUserAppointments()
        }
    }, [token])

    return (
        <div>
            <p className='pb-3 mt-12 text-lg font-medium text-gray-600 border-b'>My appointments</p>
            <div className=''>
                {appointments.map((item, index) => (
                    <div key={index} className='grid grid-cols-[1fr_2fr] gap-4 sm:flex sm:gap-6 py-4 border-b'>
                        <div>
                            <img className='w-36 bg-[#EAEFFF]' src={item.docData.image} alt="" />
                        </div>
                        <div className='flex-1 text-sm text-[#5E5E5E]'>
                            <p className='text-[#262626] text-base font-semibold'>{item.docData.name}</p>
                            <p>{item.docData.speciality}</p>
                            <p className='text-[#464646] font-medium mt-1'>Address:</p>
                            <p className=''>{item.docData.address.line1}</p>
                            <p className=''>{item.docData.address.line2}</p>
                            <p className=' mt-1'><span className='text-sm text-[#3C3C3C] font-medium'>Date & Time:</span> {slotDateFormat(item.slotDate)} |  {item.slotTime}</p>
                        </div>
                        <div></div>
                        <div className='flex flex-col gap-2 justify-end text-sm text-center'>
                            {!item.cancelled && !item.payment && !item.isCompleted && payment !== item._id && <button onClick={() => setPayment(item._id)} className='text-[#696969] sm:min-w-48 py-2 border rounded hover:bg-primary hover:text-white transition-all duration-300'>Pay Online</button>}
                            {!item.cancelled && !item.payment && !item.isCompleted && payment === item._id && <button onClick={() => appointmentStripe(item._id)} className='text-[#696969] sm:min-w-48 py-2 border rounded hover:bg-gray-100 hover:text-white transition-all duration-300 flex items-center justify-center'><img className='max-w-20 max-h-5' src={assets.stripe_logo} alt="" /></button>}
                            {!item.cancelled && !item.payment && !item.isCompleted && payment === item._id && <button onClick={() => appointmentRazorpay(item._id)} className='text-[#696969] sm:min-w-48 py-2 border rounded hover:bg-gray-100 hover:text-white transition-all duration-300 flex items-center justify-center'><img className='max-w-20 max-h-5' src={assets.razorpay_logo} alt="" /></button>}
                            {!item.cancelled && item.payment && !item.isCompleted && <button className='sm:min-w-48 py-2 border rounded text-[#696969]  bg-[#EAEFFF]'>Paid</button>}

                            {item.isCompleted && <button className='sm:min-w-48 py-2 border border-green-500 rounded text-green-500'>Completed</button>}
                            {item.isCompleted && item.prescription?.diagnosis && (
                                <button onClick={() => setSelectedPrescription(item)} className='sm:min-w-48 py-2 border border-indigo-500 rounded text-indigo-600 bg-indigo-50 hover:bg-indigo-600 hover:text-white transition-all'>
                                    View Prescription (Rx)
                                </button>
                            )}
                            {!item.cancelled && !item.isCompleted && (
                                <button onClick={() => setVideoAppointment(item)} className='sm:min-w-48 py-2 border border-blue-500 rounded text-blue-600 bg-blue-50 hover:bg-blue-600 hover:text-white transition-all flex items-center justify-center gap-1.5 font-medium'>
                                    <span>📹</span> Video Consultation
                                </button>
                            )}
                            {!item.cancelled && (
                                <button onClick={() => setChattingAppointment(item)} className='sm:min-w-48 py-2 border border-emerald-500 rounded text-emerald-600 bg-emerald-50 hover:bg-emerald-600 hover:text-white transition-all flex items-center justify-center gap-1.5'>
                                    <span>💬</span> Chat with Doctor
                                </button>
                            )}
                            {item.isCompleted && reviewingId !== item._id && <button onClick={() => setReviewingId(item._id)} className='text-[#696969] sm:min-w-48 py-2 border rounded hover:bg-primary hover:text-white transition-all duration-300'>Rate Doctor</button>}

                            {!item.cancelled && !item.isCompleted && (
                                <>
                                    <button onClick={() => setReschedulingId(reschedulingId === item._id ? '' : item._id)} className='text-[#696969] sm:min-w-48 py-2 border rounded hover:bg-blue-600 hover:text-white transition-all duration-300'>
                                        {reschedulingId === item._id ? 'Close Reschedule' : 'Reschedule Slot'}
                                    </button>
                                    <button onClick={() => cancelAppointment(item._id)} className='text-[#696969] sm:min-w-48 py-2 border rounded hover:bg-red-600 hover:text-white transition-all duration-300'>Cancel appointment</button>
                                </>
                            )}
                            {item.cancelled && !item.isCompleted && <button className='sm:min-w-48 py-2 border border-red-500 rounded text-red-500'>Appointment cancelled</button>}
                        </div>

                        {reschedulingId === item._id && (
                            <div className='col-span-2 sm:flex-1 sm:w-full mt-2 p-4 border border-blue-200 bg-blue-50/40 rounded text-sm'>
                                <p className='font-semibold text-gray-800 mb-2'>Select New Date & Time Slot:</p>
                                <div className='flex flex-wrap items-center gap-3'>
                                    <div>
                                        <label className='block text-xs text-gray-600 mb-1'>New Date:</label>
                                        <input 
                                            type='date' 
                                            min={new Date().toISOString().split('T')[0]} 
                                            value={rescheduleDate} 
                                            onChange={(e) => setRescheduleDate(e.target.value)} 
                                            className='border rounded px-3 py-1.5 text-sm bg-white' 
                                        />
                                    </div>
                                    <div>
                                        <label className='block text-xs text-gray-600 mb-1'>New Time Slot:</label>
                                        <select 
                                            value={rescheduleTime} 
                                            onChange={(e) => setRescheduleTime(e.target.value)} 
                                            className='border rounded px-3 py-1.5 text-sm bg-white'>
                                            {timeSlots.map((slot, sIdx) => (
                                                <option key={sIdx} value={slot}>{slot}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className='flex gap-2 items-end mt-4'>
                                        <button onClick={() => handleReschedule(item._id)} className='px-4 py-1.5 bg-primary text-white rounded text-sm hover:opacity-90'>Confirm New Slot</button>
                                        <button onClick={() => setReschedulingId('')} className='px-4 py-1.5 border bg-white rounded text-sm'>Cancel</button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {reviewingId === item._id && (
                            <div className='col-span-2 sm:flex-1 sm:w-full mt-2 p-4 border rounded text-sm'>
                                <p className='font-medium text-[#262626] mb-2'>Rate your experience with {item.docData.name}</p>
                                <select value={ratingValue} onChange={(e) => setRatingValue(Number(e.target.value))} className='border rounded px-2 py-1 mr-2'>
                                    <option value={5}>★★★★★ (5)</option>
                                    <option value={4}>★★★★☆ (4)</option>
                                    <option value={3}>★★★☆☆ (3)</option>
                                    <option value={2}>★★☆☆☆ (2)</option>
                                    <option value={1}>★☆☆☆☆ (1)</option>
                                </select>
                                <input
                                    type='text'
                                    value={comment}
                                    onChange={(e) => setComment(e.target.value)}
                                    placeholder='Optional comment'
                                    className='border rounded px-2 py-1 w-full sm:w-64 mt-2 sm:mt-0'
                                />
                                <div className='mt-2 flex gap-2'>
                                    <button onClick={() => submitReview(item._id)} className='px-4 py-1 bg-primary text-white rounded'>Submit</button>
                                    <button onClick={() => setReviewingId('')} className='px-4 py-1 border rounded'>Cancel</button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
            {/* Prescription View & Print Modal */}
            {selectedPrescription && (
                <div className='fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 print:p-0'>
                    <div className='bg-white rounded-xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6 border'>
                        <div className='flex justify-between items-start pb-4 border-b'>
                            <div>
                                <h2 className='text-xl font-bold text-primary'>Prescripto Healthcare</h2>
                                <p className='text-xs text-gray-500'>Digital Medical Consultation Record</p>
                            </div>
                            <button onClick={() => setSelectedPrescription(null)} className='text-gray-400 hover:text-gray-600 text-2xl font-bold print:hidden'>&times;</button>
                        </div>

                        <div className='grid grid-cols-2 gap-4 py-4 border-b text-xs text-gray-600'>
                            <div>
                                <p className='font-bold text-sm text-gray-800'>Dr. {selectedPrescription.docData?.name}</p>
                                <p>{selectedPrescription.docData?.speciality} ({selectedPrescription.docData?.degree})</p>
                                <p>{selectedPrescription.docData?.address?.line1}, {selectedPrescription.docData?.address?.line2}</p>
                            </div>
                            <div className='text-right'>
                                <p><span className='font-semibold text-gray-700'>Patient:</span> {selectedPrescription.userData?.name}</p>
                                <p><span className='font-semibold text-gray-700'>Date:</span> {slotDateFormat(selectedPrescription.slotDate)}</p>
                                <p><span className='font-semibold text-gray-700'>Time:</span> {selectedPrescription.slotTime}</p>
                            </div>
                        </div>

                        <div className='py-3 text-sm'>
                            <p className='text-xs font-semibold text-gray-500 uppercase'>Diagnosis:</p>
                            <p className='font-medium text-gray-800 mt-0.5'>{selectedPrescription.prescription?.diagnosis || 'General Consultation'}</p>
                        </div>

                        {selectedPrescription.prescription?.medicines?.length > 0 && (
                            <div className='py-3'>
                                <p className='text-xs font-semibold text-gray-500 uppercase mb-2'>Rx - Prescribed Medicines:</p>
                                <div className='border rounded overflow-hidden text-xs'>
                                    <div className='grid grid-cols-3 bg-gray-100 font-semibold p-2 text-gray-700'>
                                        <p>Medicine Name</p>
                                        <p>Dosage</p>
                                        <p>Frequency</p>
                                    </div>
                                    {selectedPrescription.prescription.medicines.map((med, idx) => (
                                        <div key={idx} className='grid grid-cols-3 p-2 border-t text-gray-600'>
                                            <p className='font-medium text-gray-800'>{med.name}</p>
                                            <p>{med.dosage || '-'}</p>
                                            <p>{med.frequency || '-'}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {selectedPrescription.prescription?.notes && (
                            <div className='py-3 text-xs text-gray-700 bg-gray-50 p-3 rounded-lg border'>
                                <p className='font-semibold text-gray-800 mb-1'>Doctor's Advice & Instructions:</p>
                                <p>{selectedPrescription.prescription.notes}</p>
                            </div>
                        )}

                        <div className='flex justify-between items-center pt-4 border-t mt-4 print:hidden'>
                            <button onClick={() => setSelectedPrescription(null)} className='px-4 py-1.5 border rounded text-xs text-gray-600'>Close</button>
                            <button onClick={() => window.print()} className='px-4 py-1.5 bg-primary text-white rounded text-xs hover:opacity-90 font-medium'>
                                Print / Download PDF
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Real-time Consultation Chat Modal */}
            {chattingAppointment && (
                <ChatModal 
                    appointment={chattingAppointment} 
                    onClose={() => setChattingAppointment(null)} 
                    currentUserRole="user" 
                />
            )}

            {/* Secure WebRTC Video Consultation Modal */}
            {videoAppointment && (
                <VideoConsultationModal
                    appointment={videoAppointment}
                    onClose={() => setVideoAppointment(null)}
                />
            )}
        </div>
    )
}

export default MyAppointments