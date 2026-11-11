# Production Dockerfile for Prescripto Backend
FROM node:20-alpine

# Install curl for healthcheck probe
RUN apk add --no-cache curl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Copy dependency definitions
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose backend API port
EXPOSE 4000

# Container liveness health check
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

# Start production server
CMD ["node", "server.js"]
