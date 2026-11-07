import React, { useContext, useEffect, useState } from 'react'
import { AppContext } from '../context/AppContext'
import axios from 'axios'
import { toast } from 'react-toastify'
import { useNavigate } from 'react-router-dom'

const Login = () => {

  const [state, setState] = useState('Sign Up')

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [loading, setLoading] = useState(false)

  const navigate = useNavigate()
  const { backendUrl, token, setToken } = useContext(AppContext)

  const handleSendOtp = async (e) => {
    e.preventDefault()
    if (!email) return toast.error('Please enter your email')
    try {
      setLoading(true)
      const { data } = await axios.post(backendUrl + '/api/user/send-reset-otp', { email })
      if (data.success) {
        toast.success(data.message)
        setOtpSent(true)
      } else {
        toast.error(data.message)
      }
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setLoading(false)
    }
  }

  const handleResetPassword = async (e) => {
    e.preventDefault()
    if (!otp || !newPassword) return toast.error('Please enter OTP and new password')
    try {
      setLoading(true)
      const { data } = await axios.post(backendUrl + '/api/user/reset-password', { email, otp, newPassword })
      if (data.success) {
        toast.success(data.message)
        setState('Login')
        setOtpSent(false)
        setOtp('')
        setNewPassword('')
      } else {
        toast.error(data.message)
      }
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setLoading(false)
    }
  }

  const onSubmitHandler = async (event) => {
    event.preventDefault();

    try {
      if (state === 'Sign Up') {
        const { data } = await axios.post(backendUrl + '/api/user/register', { name, email, password })
        if (data.success) {
          localStorage.setItem('token', data.token)
          setToken(data.token)
        } else {
          toast.error(data.message)
        }
      } else {
        const { data } = await axios.post(backendUrl + '/api/user/login', { email, password })
        if (data.success) {
          localStorage.setItem('token', data.token)
          setToken(data.token)
        } else {
          toast.error(data.message)
        }
      }
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    }
  }

  useEffect(() => {
    if (token) {
      navigate('/')
    }
  }, [token])

  if (state === 'Forgot Password') {
    return (
      <div className='min-h-[80vh] flex items-center'>
        <form onSubmit={otpSent ? handleResetPassword : handleSendOtp} className='flex flex-col gap-3 m-auto items-start p-8 min-w-[340px] sm:min-w-96 border rounded-xl text-[#5E5E5E] text-sm shadow-lg'>
          <p className='text-2xl font-semibold'>Reset Password</p>
          <p>{otpSent ? 'Enter the OTP sent to your email and your new password' : 'Enter your registered email to receive a password reset OTP'}</p>
          
          <div className='w-full'>
            <p>Email</p>
            <input 
              disabled={otpSent}
              onChange={(e) => setEmail(e.target.value)} 
              value={email} 
              className='border border-[#DADADA] rounded w-full p-2 mt-1 disabled:bg-gray-100' 
              type="email" 
              required 
            />
          </div>

          {otpSent && (
            <>
              <div className='w-full'>
                <p>6-Digit OTP</p>
                <input 
                  onChange={(e) => setOtp(e.target.value)} 
                  value={otp} 
                  placeholder="e.g. 123456"
                  maxLength={6}
                  className='border border-[#DADADA] rounded w-full p-2 mt-1 tracking-widest text-center font-bold text-lg' 
                  type="text" 
                  required 
                />
              </div>

              <div className='w-full'>
                <p>New Password</p>
                <input 
                  onChange={(e) => setNewPassword(e.target.value)} 
                  value={newPassword} 
                  placeholder="Minimum 8 characters"
                  className='border border-[#DADADA] rounded w-full p-2 mt-1' 
                  type="password" 
                  required 
                />
              </div>
            </>
          )}

          <button 
            type="submit" 
            disabled={loading}
            className='bg-primary text-white w-full py-2 my-2 rounded-md text-base disabled:opacity-60'>
            {loading ? 'Please wait...' : (otpSent ? 'Confirm & Reset Password' : 'Send Reset OTP')}
          </button>

          <p>Remembered your password? <span onClick={() => { setState('Login'); setOtpSent(false); }} className='text-primary underline cursor-pointer'>Back to Login</span></p>
        </form>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmitHandler} className='min-h-[80vh] flex items-center'>
      <div className='flex flex-col gap-3 m-auto items-start p-8 min-w-[340px] sm:min-w-96 border rounded-xl text-[#5E5E5E] text-sm shadow-lg'>
        <p className='text-2xl font-semibold'>{state === 'Sign Up' ? 'Create Account' : 'Login'}</p>
        <p>Please {state === 'Sign Up' ? 'sign up' : 'log in'} to book appointment</p>
        {state === 'Sign Up' && (
          <div className='w-full '>
            <p>Full Name</p>
            <input onChange={(e) => setName(e.target.value)} value={name} className='border border-[#DADADA] rounded w-full p-2 mt-1' type="text" required />
          </div>
        )}
        <div className='w-full '>
          <p>Email</p>
          <input onChange={(e) => setEmail(e.target.value)} value={email} className='border border-[#DADADA] rounded w-full p-2 mt-1' type="email" required />
        </div>
        <div className='w-full '>
          <div className='flex justify-between items-center'>
            <p>Password</p>
            {state === 'Login' && (
              <span onClick={() => setState('Forgot Password')} className='text-xs text-primary underline cursor-pointer'>
                Forgot password?
              </span>
            )}
          </div>
          <input onChange={(e) => setPassword(e.target.value)} value={password} className='border border-[#DADADA] rounded w-full p-2 mt-1' type="password" required />
        </div>
        <button className='bg-primary text-white w-full py-2 my-2 rounded-md text-base'>{state === 'Sign Up' ? 'Create account' : 'Login'}</button>
        {state === 'Sign Up'
          ? <p>Already have an account? <span onClick={() => setState('Login')} className='text-primary underline cursor-pointer'>Login here</span></p>
          : <p>Create an new account? <span onClick={() => setState('Sign Up')} className='text-primary underline cursor-pointer'>Click here</span></p>
        }
      </div>
    </form>
  )
}

export default Login