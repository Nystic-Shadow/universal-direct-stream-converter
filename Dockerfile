FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy application code
COPY . .

# Expose web & streaming port
EXPOSE 3000

# Healthcheck endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Launch stream server
CMD ["node", "server.js"]
