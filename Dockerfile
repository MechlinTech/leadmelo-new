FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-fund
ARG CACHEBUST=css
RUN echo "cachebust=$CACHEBUST"
COPY . .
RUN npm run db:generate && npm run build
# Reuse the build tree as the runtime image. Copying /app into a second stage regularly
# trips Docker Desktop's overlayfs (read-only metadata.db) on this host.
FROM build
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN mkdir -p /var/lib/leadmelo-gateway && chown node:node /var/lib/leadmelo-gateway
USER node
EXPOSE 3000
CMD ["npm","start"]
