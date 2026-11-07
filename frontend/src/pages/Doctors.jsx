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
  const [onlyAvailable, setOnlyAvailable] = useState(false)
  const [sortBy, setSortBy] = useState('default')
  const [currentPage, setCurrentPage] = useState(1)
  const doctorsPerPage = 8
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

    if (onlyAvailable) {
      doctorsList = doctorsList.filter(doc => doc.available)
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
    setCurrentPage(1)
  }

  useEffect(() => {
    applyFilter()
  }, [doctors, speciality, searchTerm, maxFees, minRating, onlyAvailable, sortBy])

  // Pagination calculation
  const indexOfLastDoctor = currentPage * doctorsPerPage
  const indexOfFirstDoctor = indexOfLastDoctor - doctorsPerPage
  const currentDoctors = filterDoc.slice(indexOfFirstDoctor, indexOfLastDoctor)
  const totalPages = Math.ceil(filterDoc.length / doctorsPerPage)

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
        <label className='flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none px-3 py-2 border rounded border-gray-300 bg-white'>
          <input
            type='checkbox'
            checked={onlyAvailable}
            onChange={(e) => setOnlyAvailable(e.target.checked)}
            className='w-4 h-4 text-primary rounded cursor-pointer'
          />
          <span className='whitespace-nowrap'>Available Only</span>
        </label>
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
        <div className='w-full'>
          {currentDoctors.length === 0 ? (
            <div className='text-center py-12 text-gray-500 border rounded-xl'>
              <p className='text-base font-medium'>No doctors found matching your filter criteria.</p>
              <p className='text-xs text-gray-400 mt-1'>Try adjusting your search keywords, fees, or rating filter.</p>
            </div>
          ) : (
            <div className='w-full grid grid-cols-auto gap-4 gap-y-6'>
              {currentDoctors.map((item, index) => (
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
          )}

          {/* Pagination Controls */}
          {totalPages > 1 && (
            <div className='flex justify-center items-center gap-2 mt-8'>
              <button 
                disabled={currentPage === 1}
                onClick={() => { setCurrentPage(prev => Math.max(prev - 1, 1)); scrollTo(0, 0) }}
                className='px-3 py-1.5 border rounded text-xs text-gray-600 disabled:opacity-40 hover:bg-gray-100'>
                Previous
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
                <button
                  key={page}
                  onClick={() => { setCurrentPage(page); scrollTo(0, 0) }}
                  className={`px-3 py-1.5 border rounded text-xs font-medium ${currentPage === page ? 'bg-primary text-white border-primary' : 'hover:bg-gray-100 text-gray-700'}`}>
                  {page}
                </button>
              ))}
              <button 
                disabled={currentPage === totalPages}
                onClick={() => { setCurrentPage(prev => Math.min(prev + 1, totalPages)); scrollTo(0, 0) }}
                className='px-3 py-1.5 border rounded text-xs text-gray-600 disabled:opacity-40 hover:bg-gray-100'>
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default Doctors