FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S skillhub && adduser -S skillhub -G skillhub
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY app ./app
COPY schemas ./schemas
RUN mkdir -p /data/packages && chown -R skillhub:skillhub /data /app
USER skillhub
EXPOSE 4777
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:4777/api/health || exit 1
CMD ["node", "server.js"]

