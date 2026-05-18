FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install --omit=dev --silent

# Copy application files
COPY server.js ./
COPY public/ ./public/

EXPOSE 8099

ENV PORT=8099 \
    NODE_ENV=production

CMD ["node", "server.js"]
