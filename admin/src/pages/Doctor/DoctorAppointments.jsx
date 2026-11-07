import React, { useState } from 'react'
import { useContext, useEffect } from 'react'
import { DoctorContext } from '../../context/DoctorContext'
import { AppContext } from '../../context/AppContext'
import { assets } from '../../assets/assets'
import axios from 'axios'
import { toast } from 'react-toastify'

const DoctorAppointments = () => {

  const { backendUrl, dToken, appointments, getAppointments, cancelAppointment, completeAppointment } = useContext(DoctorContext)
  const { slotDateFormat, calculateAge, currency } = useContext(AppContext)

  // Prescription Modal State
  const [activeAppointment, setActiveAppointment] = useState(null)
  const [diagnosis, setDiagnosis] = useState('')
  const [notes, setNotes] = useState('')
  const [medicines, setMedicines] = useState([{ name: '', dosage: '', frequency: '' }])
  const [saving, setSaving] = useState(false)

  const openPrescriptionModal = (item) => {
    setActiveAppointment(item)
    if (item.prescription) {
      setDiagnosis(item.prescription.diagnosis || '')
      setNotes(item.prescription.notes || '')
      setMedicines(item.prescription.medicines?.length ? item.prescription.medicines : [{ name: '', dosage: '', frequency: '' }])
    } else {
      setDiagnosis('')
      setNotes('')
      setMedicines([{ name: '', dosage: '', frequency: '' }])
    }
  }

  const handleMedicineChange = (idx, field, val) => {
    const updated = [...medicines]
    updated[idx][field] = val
    setMedicines(updated)
  }

  const addMedicineRow = () => {
    setMedicines([...medicines, { name: '', dosage: '', frequency: '' }])
  }

  const removeMedicineRow = (idx) => {
    if (medicines.length > 1) {
      setMedicines(medicines.filter((_, i) => i !== idx))
    }
  }

  const handleSavePrescription = async (e) => {
    e.preventDefault()
    if (!activeAppointment) return
    try {
      setSaving(true)
      const validMedicines = medicines.filter(m => m.name.trim() !== '')
      const { data } = await axios.post(
        backendUrl + '/api/doctor/add-prescription',
        {
          appointmentId: activeAppointment._id,
          diagnosis,
          notes,
          medicines: validMedicines
        },
        { headers: { dToken } }
      )

      if (data.success) {
        toast.success(data.message)
        setActiveAppointment(null)
        getAppointments()
      } else {
        toast.error(data.message)
      }
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (dToken) {
      getAppointments()
    }
  }, [dToken])

  return (
    <div className='w-full max-w-6xl m-5 '>

      <p className='mb-3 text-lg font-medium'>All Appointments</p>

      <div className='bg-white border rounded text-sm max-h-[80vh] overflow-y-scroll'>
        <div className='max-sm:hidden grid grid-cols-[0.5fr_2fr_1fr_1fr_2.5fr_1fr_2fr] gap-1 py-3 px-6 border-b'>
          <p>#</p>
          <p>Patient</p>
          <p>Payment</p>
          <p>Age</p>
          <p>Date & Time</p>
          <p>Fees</p>
          <p>Action</p>
        </div>
        {appointments.map((item, index) => (
          <div className='flex flex-wrap justify-between max-sm:gap-5 max-sm:text-base sm:grid grid-cols-[0.5fr_2fr_1fr_1fr_2.5fr_1fr_2fr] gap-1 items-center text-gray-500 py-3 px-6 border-b hover:bg-gray-50' key={index}>
            <p className='max-sm:hidden'>{index + 1}</p>
            <div className='flex items-center gap-2'>
              <img src={item.userData.image} className='w-8 h-8 object-cover rounded-full' alt="" /> <p>{item.userData.name}</p>
            </div>
            <div>
              <p className='text-xs inline border border-primary px-2 rounded-full'>
                {item.payment?'Online':'CASH'}
              </p>
            </div>
            <p className='max-sm:hidden'>{calculateAge(item.userData.dob)}</p>
            <p>{slotDateFormat(item.slotDate)}, {item.slotTime}</p>
            <p>{currency}{item.amount}</p>
            {item.cancelled
              ? <p className='text-red-400 text-xs font-medium'>Cancelled</p>
              : item.isCompleted
                ? <div className='flex items-center gap-2'>
                    <span className='text-green-500 text-xs font-medium'>Completed</span>
                    <button onClick={() => openPrescriptionModal(item)} className='text-xs px-2.5 py-1 bg-indigo-50 text-indigo-600 border border-indigo-200 rounded hover:bg-indigo-600 hover:text-white transition-all'>
                      {item.prescription?.diagnosis ? 'Edit Rx' : '+ Write Rx'}
                    </button>
                  </div>
                : <div className='flex items-center gap-2'>
                    <img onClick={() => cancelAppointment(item._id)} title="Cancel Appointment" className='w-8 cursor-pointer hover:opacity-80' src={assets.cancel_icon} alt="" />
                    <img onClick={() => completeAppointment(item._id)} title="Complete Appointment" className='w-8 cursor-pointer hover:opacity-80' src={assets.tick_icon} alt="" />
                    <button onClick={() => openPrescriptionModal(item)} className='text-xs px-2 py-1 bg-blue-50 text-blue-600 border border-blue-200 rounded hover:bg-blue-600 hover:text-white'>
                      Write Rx
                    </button>
                  </div>
            }
          </div>
        ))}
      </div>

      {/* Prescription Modal */}
      {activeAppointment && (
        <div className='fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4'>
          <div className='bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6'>
            <div className='flex justify-between items-center pb-3 border-b mb-4'>
              <div>
                <h3 className='text-lg font-bold text-gray-800'>Digital Prescription (Rx)</h3>
                <p className='text-xs text-gray-500'>Patient: <span className='font-semibold text-gray-700'>{activeAppointment.userData.name}</span> | Date: {slotDateFormat(activeAppointment.slotDate)}</p>
              </div>
              <button onClick={() => setActiveAppointment(null)} className='text-gray-400 hover:text-gray-600 text-2xl font-bold'>&times;</button>
            </div>

            <form onSubmit={handleSavePrescription} className='flex flex-col gap-4 text-sm'>
              <div>
                <label className='block font-medium text-gray-700 mb-1'>Diagnosis / Condition:</label>
                <input 
                  type="text" 
                  value={diagnosis} 
                  onChange={(e) => setDiagnosis(e.target.value)} 
                  placeholder="e.g. Acute Bronchitis, Migraine, Routine Checkup"
                  required
                  className='w-full border rounded-lg p-2.5 outline-none focus:border-primary'
                />
              </div>

              <div>
                <div className='flex justify-between items-center mb-1'>
                  <label className='font-medium text-gray-700'>Prescribed Medicines:</label>
                  <button type="button" onClick={addMedicineRow} className='text-xs text-primary font-semibold hover:underline'>+ Add Medicine</button>
                </div>
                {medicines.map((med, mIdx) => (
                  <div key={mIdx} className='grid grid-cols-[2fr_1.5fr_1.5fr_auto] gap-2 mb-2 items-center'>
                    <input 
                      type="text" 
                      placeholder="Medicine Name (e.g. Paracetamol)" 
                      value={med.name} 
                      onChange={(e) => handleMedicineChange(mIdx, 'name', e.target.value)} 
                      className='border rounded p-2 text-xs' 
                    />
                    <input 
                      type="text" 
                      placeholder="Dosage (e.g. 500mg)" 
                      value={med.dosage} 
                      onChange={(e) => handleMedicineChange(mIdx, 'dosage', e.target.value)} 
                      className='border rounded p-2 text-xs' 
                    />
                    <input 
                      type="text" 
                      placeholder="Frequency (e.g. 1-0-1 after food)" 
                      value={med.frequency} 
                      onChange={(e) => handleMedicineChange(mIdx, 'frequency', e.target.value)} 
                      className='border rounded p-2 text-xs' 
                    />
                    {medicines.length > 1 && (
                      <button type="button" onClick={() => removeMedicineRow(mIdx)} className='text-red-500 font-bold px-1'>&times;</button>
                    )}
                  </div>
                ))}
              </div>

              <div>
                <label className='block font-medium text-gray-700 mb-1'>Doctor's Notes & Advice:</label>
                <textarea 
                  rows={3} 
                  value={notes} 
                  onChange={(e) => setNotes(e.target.value)} 
                  placeholder="e.g. Drink 3L water daily, take rest, revisit after 5 days if fever persists."
                  className='w-full border rounded-lg p-2.5 outline-none focus:border-primary text-xs'
                />
              </div>

              <div className='flex justify-end gap-2 pt-3 border-t'>
                <button type="button" onClick={() => setActiveAppointment(null)} className='px-4 py-2 border rounded-lg text-gray-600 hover:bg-gray-100'>Cancel</button>
                <button type="submit" disabled={saving} className='px-5 py-2 bg-primary text-white rounded-lg hover:opacity-90 disabled:opacity-50'>
                  {saving ? 'Saving...' : 'Save & Issue Prescription'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  )
}

export default DoctorAppointments