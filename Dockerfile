FROM node:20-alpine

# Add non-root user for security
RUN addgroup -S loracord && adduser -S loracord -G loracord

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source
COPY src/ ./src/

# Drop to non-root
USER loracord

ENV NODE_ENV=production

CMD ["node", "src/index.js"]
