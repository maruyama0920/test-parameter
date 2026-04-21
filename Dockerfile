FROM node:20-slim

WORKDIR /app

# Install dependencies including devDependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npx tsc

# Remove devDependencies
RUN npm ci --only=production

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/index.js"]