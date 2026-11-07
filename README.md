# Prescripto - Online Doctor Consultation & Appointment Platform
 
Prescripto is a full-stack MERN healthcare application that enables patients to search specialists, book consultation slots in real-time, and make secure online payments. It features a three-tier portal architecture: Patient Client, Doctor Workspace, and Super Admin Management.

## Key Features 
- **Patient Portal**: Register, filter doctors by speciality, book appointments with real-time double-booking prevention, pay via Razorpay/Stripe, review doctors, and manage bookings.
- **Doctor Portal**: Dedicated dashboard with earnings analytics, unique patient tracking, appointment status updates (Complete/Cancel), and live availability toggling.
- **Admin Dashboard**: Comprehensive analytics, new doctor onboarding with Cloudinary photo uploads, and platform-wide appointment controls.
- **Dual Payment Integration**: Secure payments through Razorpay (UPI, NetBanking, Cards) and Stripe with server-side validation.
- **Automated Email Notifications**: Booking confirmation and cancellation email alerts powered by Nodemailer.
- **Production-Ready Security**: JWT authentication, bcrypt password hashing, express-rate-limit protection against brute-force logins, and Helmet HTTP security headers.
 
## Tech Stack  
- **Frontend & Admin**: React 18, Vite, Tailwind CSS, React Router v6, Axios, React Toastify
- **Backend**: Node.js, Express.js
- **Database**: MongoDB with Mongoose (Indexed queries & atomic slot constraints)
- **File Storage**: Cloudinary & Multer
- **Payment Gateways**: Razorpay & Stripe
- **Email Service**: Nodemailer (SMTP)
 
## Getting Started

### 1. Clone the repository
```bash
git clone https://github.com/Tushar-1208-cyber/Prescripto.git
cd Prescripto
```

### 2. Configure Environment Variables
Copy `.env.example` in each folder and provide your credentials:
```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp admin/.env.example admin/.env
```

### 3. Start the Backend API Server
```bash
cd backend
npm install
npm run server
# Running at http://localhost:4000
```

### 4. Start the Frontend Application (Patient Portal)
```bash
cd frontend
npm install
npm run dev
# Running at http://localhost:5173
```

### 5. Start the Admin & Doctor Dashboard
```bash
cd admin
npm install
npm run dev
# Running at http://localhost:5174
```

## Contribution
Contributions and feature suggestions are welcome! Feel free to fork the repository and submit a pull request.

## License
This project is licensed under the MIT License.

