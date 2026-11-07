import React, { useContext, useEffect } from 'react'
import { AdminContext } from '../../context/AdminContext'

const DoctorsList = () => {

  const { doctors, changeAvailability, aToken, getAllDoctors, deleteDoctor } = useContext(AdminContext)

  const handleDelete = (docId, name) => {
    if (window.confirm(`Are you sure you want to delete Dr. ${name} from Prescripto?`)) {
      deleteDoctor(docId)
    }
  }

  useEffect(() => {
    if (aToken) {
        getAllDoctors()
    }
}, [aToken])

  return (
    <div className='m-5 max-h-[90vh] overflow-y-scroll'>
      <h1 className='text-lg font-medium'>All Doctors</h1>
      <div className='w-full flex flex-wrap gap-4 pt-5 gap-y-6'>
        {doctors.map((item, index) => (
          <div className='border border-[#C9D8FF] rounded-xl max-w-56 overflow-hidden cursor-pointer group' key={index}>
            <img className='bg-[#EAEFFF] group-hover:bg-primary transition-all duration-500' src={item.image} alt="" />
            <div className='p-4'>
              <p className='text-[#262626] text-lg font-medium'>{item.name}</p>
              <p className='text-[#5C5C5C] text-sm'>{item.speciality}</p>
              {item.reviewCount > 0 && (
                <p className='text-yellow-500 text-sm mt-1'>★ {item.averageRating} ({item.reviewCount})</p>
              )}
              <div className='mt-3 flex items-center justify-between text-sm'>
                <label className='flex items-center gap-1 cursor-pointer'>
                  <input onChange={()=>changeAvailability(item._id)} type="checkbox" checked={item.available} />
                  <span className='text-xs'>Available</span>
                </label>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleDelete(item._id, item.name); }}
                  className='text-xs px-2 py-0.5 text-red-600 border border-red-200 rounded hover:bg-red-600 hover:text-white transition-all'>
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default DoctorsList