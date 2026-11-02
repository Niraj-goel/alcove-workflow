FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# All live data (database, uploaded PDFs, backups) lives in /data.
# Mount a persistent volume here, otherwise data is lost on every redeploy.
ENV NODE_ENV=production \
    TZ=Asia/Kolkata \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    UPLOAD_DIR=/data/uploads
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
