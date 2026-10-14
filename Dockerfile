FROM node:20-bookworm-slim

# Install system dependencies: python3, ffmpeg, curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install latest yt-dlp binary directly
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# Build client bundle so it serves static frontend + API from one single container
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["npm", "start"]
