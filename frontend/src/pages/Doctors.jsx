import React, { useContext, useEffect, useState } from 'react'
import { AppContext } from '../context/AppContext'
import { useNavigate, useParams } from 'react-router-dom'

const Doctors = () => {

  const { speciality } = useParams()

  const [filterDoc, setFilterDoc] = useState([])
  const [showFilter, setShowFilter] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [maxFees, setMaxFees] = useState('')
  const [minRating, setMinRating] = useState(0)
  const [sortBy, setSortBy] = useState('default')
  const navigate = useNavigate();

  const { doctors } = useContext(AppContext)

  const applyFilter = () => {
    let doctorsList = doctors.slice()

    if (speciality) {
      doctorsList = doctorsList.filter(doc => doc.speciality === speciality)
    }

    if (searchTerm.trim()) {
      doctorsList = doctorsList.filter(doc =>
        doc.name.toLowerCase().includes(searchTerm.trim().toLowerCase())
      )
    }

    if (maxFees) {
      doctorsList = doctorsList.filter(doc => doc.fees <= Number(maxFees))
    }

    if (minRating > 0) {
      doctorsList = doctorsList.filter(doc => (doc.averageRating || 0) >= minRating)
    }

    if (sortBy === 'fees-low') {
      doctorsList.sort((a, b) => a.fees - b.fees)
    } else if (sortBy === 'fees-high') {
      doctorsList.sort((a, b) => b.fees - a.fees)
    } else if (sortBy === 'experience') {
      doctorsList.sort((a, b) => parseInt(b.experience) - parseInt(a.experience))
    } else if (sortBy === 'rating') {
      doctorsList.sort((a, b) => (b.averageRating || 0) - (a.averageRating || 0))
    }

    setFilterDoc(doctorsList)
  }

  useEffect(() => {
    applyFilter()
  }, [doctors, speciality, searchTerm, maxFees, minRating, sortBy])

  return (
    <div>
      <p className='text-gray-600'>Browse through the doctors specialist.</p>

      <div className='flex flex-col sm:flex-row gap-3 mt-4'>
        <input
          type='text'
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder='Search doctor by name'
          className='border border-gray-300 rounded px-3 py-2 text-sm w-full sm:w-64'
        />
        <input
          type='number'
          min='0'
          value={maxFees}
          onChange={(e) => setMaxFees(e.target.value)}
          placeholder='Max fees'
          className='border border-gray-300 rounded px-3 py-2 text-sm w-full sm:w-32'
        />
        <select
          value={minRating}
          onChange={(e) => setMinRating(Number(e.target.value))}
          className='border border-gray-300 rounded px-3 py-2 text-sm w-full sm:w-40'
        >
          <option value={0}>Any Rating</option>
          <option value={4}>4★ & above</option>
          <option value={3}>3★ & above</option>
          <option value={2}>2★ & above</option>
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className='border border-gray-300 rounded px-3 py-2 text-sm w-full sm:w-48'
        >
          <option value='default'>Sort By</option>
          <option value='fees-low'>Fees: Low to High</option>
          <option value='fees-high'>Fees: High to Low</option>
          <option value='experience'>Experience</option>
          <option value='rating'>Rating</option>
        </select>
      </div>

      <div className='flex flex-col sm:flex-row items-start gap-5 mt-5'>
        <button onClick={() => setShowFilter(!showFilter)} className={`py-1 px-3 border rounded text-sm  transition-all sm:hidden ${showFilter ? 'bg-primary text-white' : ''}`}>Filters</button>
        <div className={`flex-col gap-4 text-sm text-gray-600 ${showFilter ? 'flex' : 'hidden sm:flex'}`}>
          <p onClick={() => speciality === 'General physician' ? navigate('/doctors') : navigate('/doctors/General physician')} className={`w-[94vw] sm:w-auto pl-3 py-1.5 pr-16 border border-gray-300 rounded transition-all cursor-pointer ${speciality === 'General physician' ? 'bg-[#E2E5FF] text-black ' : ''}`}>General physician</p>
          <p onClick={() => speciality === 'Gynecologist' ? navigate('/doctors') : navigate('/doctors/Gynecologist')} className={`w-[94vw] sm:w-auto pl-3 py-1.5 pr-16 border border-gray-300 rounded transition-all cursor-pointer ${speciality === 'Gynecologist' ? 'bg-[#E2E5FF] text-black ' : ''}`}>Gynecologist</p>
          <p onClick={() => speciality === 'Dermatologist' ? navigate('/doctors') : navigate('/doctors/Dermatologist')} className={`w-[94vw] sm:w-auto pl-3 py-1.5 pr-16 border border-gray-300 rounded transition-all cursor-pointer ${speciality === 'Dermatologist' ? 'bg-[#E2E5FF] text-black ' : ''}`}>Dermatologist</p>
          <p onClick={() => speciality === 'Pediatricians' ? navigate('/doctors') : navigate('/doctors/Pediatricians')} className={`w-[94vw] sm:w-auto pl-3 py-1.5 pr-16 border border-gray-300 rounded transition-all cursor-pointer ${speciality === 'Pediatricians' ? 'bg-[#E2E5FF] text-black ' : ''}`}>Pediatricians</p>
          <p onClick={() => speciality === 'Neurologist' ? navigate('/doctors') : navigate('/doctors/Neurologist')} className={`w-[94vw] sm:w-auto pl-3 py-1.5 pr-16 border border-gray-300 rounded transition-all cursor-pointer ${speciality === 'Neurologist' ? 'bg-[#E2E5FF] text-black ' : ''}`}>Neurologist</p>
          <p onClick={() => speciality === 'Gastroenterologist' ? navigate('/doctors') : navigate('/doctors/Gastroenterologist')} className={`w-[94vw] sm:w-auto pl-3 py-1.5 pr-16 border border-gray-300 rounded transition-all cursor-pointer ${speciality === 'Gastroenterologist' ? 'bg-[#E2E5FF] text-black ' : ''}`}>Gastroenterologist</p>
        </div>
        <div className='w-full grid grid-cols-auto gap-4 gap-y-6'>
          {filterDoc.map((item, index) => (
            <div onClick={() => { navigate(`/appointment/${item._id}`); scrollTo(0, 0) }} className='border border-[#C9D8FF] rounded-xl overflow-hidden cursor-pointer hover:translate-y-[-10px] transition-all duration-500' key={index}>
              <img className='bg-[#EAEFFF]' src={item.image} alt="" />
              <div className='p-4'>
                <div className={`flex items-center gap-2 text-sm text-center ${item.available ? 'text-green-500' : "text-gray-500"}`}>
                  <p className={`w-2 h-2 rounded-full ${item.available ? 'bg-green-500' : "bg-gray-500"}`}></p><p>{item.available ? 'Available' : "Not Available"}</p>
                </div>
                <p className='text-[#262626] text-lg font-medium'>{item.name}</p>
                <p className='text-[#5C5C5C] text-sm'>{item.speciality}</p>
                {item.reviewCount > 0 && (
                  <p className='text-yellow-500 text-sm mt-1'>★ {item.averageRating} ({item.reviewCount})</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Doctors