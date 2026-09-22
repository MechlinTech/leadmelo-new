FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-fund
COPY . .
RUN npm run db:generate && npm run build
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app /app
# Writable state for the optional provider gateway (idempotency/"already bought" store). A named volume
# mounted here inherits this ownership on first use.
RUN mkdir -p /var/lib/leadmelo-gateway && chown node:node /var/lib/leadmelo-gateway
USER node
EXPOSE 3000
CMD ["npm","start"]
