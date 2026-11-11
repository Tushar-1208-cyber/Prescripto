# Prescripto - Online Doctor Consultation & Healthcare Platform

Prescripto is an enterprise-grade, full-stack healthcare application enabling patients to discover specialists, book consultation slots in real-time, attend consultations, and complete secure payments. It features a three-tier portal architecture: Patient Client, Doctor Workspace, and Super Admin Management.

---

## Key Architecture & Features

- **Patient Portal**: Search doctors by speciality/name/rating, real-time double-booking atomic locks, online payments (Stripe Checkout & Razorpay), digital prescriptions (Rx), and consultation history.
- **Doctor Workspace**: Real-time consultation dashboard, earnings analytics, patient history, appointment scheduling, and digital prescription writer.
- **Admin Management**: Onboarding verification, doctor approval/revocation workflow, patient suspension moderation, and system-wide analytics.
- **Real-Time Video & Chat**: End-to-end authenticated WebRTC video rooms and Socket.io messaging with persistent MongoDB audit trail.
- **Payment & Automated Refund Engine**:
  - Double-entry payment identifier persistence (`paymentId`, `orderId`, `checkoutSessionId`, `paymentAmountMinor`, `paymentCurrency`).
  - Cryptographic server-to-server webhook ingestion for Stripe and Razorpay with durable event deduplication (`webhookevents` with 30-day TTL).
  - Isolated idempotent refund service (`processRefund`) handling synchronous outcomes, pending settlements, network timeouts, and lock fencing.
  - Automated refund recovery cron scheduler (`reconcilePendingRefunds`) discovering and reconciling orphaned pending refunds after restarts.
- **Production Hardened**:
  - Connection retry with exponential backoff on MongoDB.
  - Graceful shutdown handlers (`SIGTERM`, `SIGINT`) cleanly closing HTTP server, Socket.io, and MongoDB connections.
  - Liveness (`/health`) and Readiness (`/ready`) probe endpoints for Kubernetes / Docker / load balancers.
  - Multi-stage Dockerfiles with production Nginx SPA static serving and container health checks.

---

## Tech Stack

| Layer | Technologies |
| :--- | :--- |
| **Backend** | Node.js (ES Modules), Express.js, Socket.io, Helmet, CORS |
| **Database** | MongoDB 6+, Mongoose (Atomic transactions & partial unique indexes) |
| **Frontend & Admin** | React 18, Vite, Tailwind CSS, React Router v6, Axios, Lucide Icons |
| **Payments** | Stripe API (v16+), Razorpay API (HMAC-SHA256 & HTTP Idempotency) |
| **Storage & Media** | Cloudinary API, Multer file filters & magic byte verification |
| **Notifications** | Nodemailer (SMTP with safe skipped mode if unconfigured) |
| **DevOps & Containers** | Docker, Docker Compose, Multi-stage Nginx builds, GitHub Actions |

---

## Prerequisites

- **Node.js**: `v20.x` or `v22.x` LTS
- **npm**: `v10.x` or higher
- **MongoDB**: `v6.0` or higher (Local instance or MongoDB Atlas)
- **Docker & Docker Compose**: (Optional, for containerized deployment)

---

## Environment Setup

Copy example environment files to `.env` in each respective directory:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
cp admin/.env.example admin/.env
```

### 1. Backend Configuration (`backend/.env`)

```ini
PORT=4000
CURRENCY="INR"
JWT_SECRET="your_secure_random_jwt_secret_min_32_chars"

# Allowed CORS Origins (comma-separated for production)
ALLOWED_ORIGINS="http://localhost:5173,http://localhost:5174,http://localhost:3000,https://yourdomain.com"

# Admin Panel Credentials
ADMIN_EMAIL="admin@example.com"
ADMIN_PASSWORD="your_admin_secure_password"
# Or provide a pre-computed bcrypt hash:
# ADMIN_PASSWORD_HASH="$2b$10$..."

# MongoDB Connection String
MONGODB_URI="mongodb://127.0.0.1:27017/prescripto"

# Cloudinary Setup (Doctor profile pictures and assets)
CLOUDINARY_NAME="your_cloudinary_cloud_name"
CLOUDINARY_API_KEY="your_cloudinary_api_key"
CLOUDINARY_SECRET_KEY="your_cloudinary_secret_key"

# Razorpay Payment Integration
RAZORPAY_KEY_ID="rzp_live_..."
RAZORPAY_KEY_SECRET="your_razorpay_secret"
RAZORPAY_WEBHOOK_SECRET="your_razorpay_webhook_secret"

# Stripe Payment Integration
STRIPE_SECRET_KEY="sk_live_..."
STRIPE_WEBHOOK_SECRET="whsec_..."

# Automated Refund Reconciler Scheduler
REFUND_RECONCILER_INTERVAL_MIN=15
REFUND_RECONCILER_BATCH_SIZE=20

# Nodemailer SMTP Configuration (Optional - skipped safely if empty)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT=587
SMTP_USER="notifications@yourdomain.com"
SMTP_PASS="your_smtp_app_password"
SMTP_FROM='"Prescripto Healthcare" <notifications@yourdomain.com>'

# WebRTC Video Consultation Configuration
RTC_STUN_SERVER="stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
```

### 2. Frontend Configuration (`frontend/.env`)

```ini
VITE_BACKEND_URL="http://localhost:4000"
VITE_RAZORPAY_KEY_ID="rzp_test_..."
```

### 3. Admin Panel Configuration (`admin/.env`)

```ini
VITE_BACKEND_URL="http://localhost:4000"
VITE_CURRENCY="₹"
```

---

## Local Development & Manual Installation

### 1. Install Dependencies
```bash
npm --prefix backend install
npm --prefix frontend install
npm --prefix admin install
```

### 2. Run Development Servers
In separate terminal sessions:

```bash
# Terminal 1 - Backend Server (Port 4000)
cd backend && npm run server

# Terminal 2 - Patient Frontend (Port 5173)
cd frontend && npm run dev

# Terminal 3 - Doctor & Admin Panel (Port 5174)
cd admin && npm run dev
```

---

## Production Build & Static Compilation

To verify production compilation of frontend and admin client applications:

```bash
# Build patient portal
npm --prefix frontend run build
# Compiles to frontend/dist

# Build admin portal
npm --prefix admin run build
# Compiles to admin/dist
```

---

## Docker Production Deployment

Prescripto includes production-hardened multi-stage Docker configurations.

### Architecture in Docker Compose:
- **`prescripto_mongodb`**: MongoDB 6 container with private internal network (not exposed publicly to the host by default), persistent storage volume `mongo_data`, and mongosh healthcheck.
- **`prescripto_backend`**: Node.js 20 Alpine container running production server on port 4000, with curl healthcheck against `/health`.
- **`prescripto_frontend`**: Multi-stage build compiled with Vite and served via lightweight Nginx Alpine on port 5173 (maps host 5173 to container 80) with client-side SPA routing.
- **`prescripto_admin`**: Multi-stage build compiled with Vite and served via Nginx Alpine on port 5174 (maps host 5174 to container 80) with client-side SPA routing.

### Start All Services:
```bash
docker compose up -d --build
```

### Check Service Health & Status:
```bash
docker compose ps
```

### View Unified Logs:
```bash
docker compose logs -f
```

### Stop Services:
```bash
docker compose down
```

---

## Health Checks & Monitoring

The backend exposes standard health probe endpoints for Kubernetes, Docker, and reverse proxies:

### 1. Liveness Probe (`GET /health`)
- **URL**: `http://localhost:4000/health`
- **Response**: `200 OK`
```json
{
  "status": "ok",
  "uptime": 3600,
  "timestamp": "2026-11-11T12:00:00.000Z"
}
```

### 2. Readiness Probe (`GET /ready`)
- **URL**: `http://localhost:4000/ready`
- **Response**: `200 OK` when MongoDB is fully connected; `503 Service Unavailable` during startup, network partitions, or database reconnections.
```json
{
  "status": "ready",
  "database": "connected",
  "uptime": 3600,
  "timestamp": "2026-11-11T12:00:00.000Z"
}
```

---

## Payment Webhook Configuration

Prescripto processes asynchronous payment confirmations and refund status events via cryptographic server-to-server webhooks:

### 1. Stripe Webhooks
- **Webhook Endpoint**: `POST https://yourdomain.com/api/webhook/stripe`
- **Configured Events**:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `refund.updated`
- **Signature Header**: `stripe-signature` verified against `STRIPE_WEBHOOK_SECRET` using `req.rawBody`.

### 2. Razorpay Webhooks
- **Webhook Endpoint**: `POST https://yourdomain.com/api/webhook/razorpay`
- **Configured Events**:
  - `order.paid`
  - `payment.captured`
  - `refund.processed`
  - `refund.failed`
- **Signature Header**: `x-razorpay-signature` verified using HMAC-SHA256 against `RAZORPAY_WEBHOOK_SECRET` via constant-time comparison (`crypto.timingSafeEqual`).

---

## Production Deployment Checklist

1. **Environment Secrets**: Ensure `JWT_SECRET`, `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`, `STRIPE_WEBHOOK_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` are generated securely using high-entropy random strings.
2. **Database Security**: Never expose MongoDB directly to the internet; use private VPCs, authentication, and SSL/TLS.
3. **CORS Restrictions**: Set `ALLOWED_ORIGINS` in `backend/.env` strictly to your production domain origins (e.g. `https://prescripto.com,https://admin.prescripto.com`).
4. **NTP Time Synchronization**: Ensure server system clocks are synchronized via NTP to satisfy Stripe's 300-second signature timestamp tolerance.
5. **Reverse Proxy Configuration**: Ensure reverse proxies (Nginx / Cloudflare / AWS ALB) forward raw request bodies and preserve headers (`stripe-signature`, `x-razorpay-signature`, `x-razorpay-event-id`).
6. **Graceful Shutdown**: Process managers (PM2 / Kubernetes / Docker) should send `SIGTERM` and allow up to 10 seconds for clean socket, HTTP server, and database connection termination.

---

## License

This project is licensed under the MIT License.
