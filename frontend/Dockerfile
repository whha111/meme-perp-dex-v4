# Build stage
FROM node:20-alpine AS builder

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (use npm install for lock file compatibility across npm versions)
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Build arguments for environment variables
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEBSOCKET_URL
ARG NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
# Contract addresses (critical: these get baked into client-side JS bundle)
ARG NEXT_PUBLIC_MATCHING_ENGINE_URL
ARG NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS
ARG NEXT_PUBLIC_SETTLEMENT_ADDRESS
ARG NEXT_PUBLIC_VAULT_ADDRESS
ARG NEXT_PUBLIC_PRICE_FEED_ADDRESS
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_BASE_TESTNET_RPC_URL

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WEBSOCKET_URL=$NEXT_PUBLIC_WEBSOCKET_URL
ENV NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID
ENV NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ENV NEXT_PUBLIC_MATCHING_ENGINE_URL=$NEXT_PUBLIC_MATCHING_ENGINE_URL
ENV NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS=$NEXT_PUBLIC_TOKEN_FACTORY_ADDRESS
ENV NEXT_PUBLIC_SETTLEMENT_ADDRESS=$NEXT_PUBLIC_SETTLEMENT_ADDRESS
ENV NEXT_PUBLIC_VAULT_ADDRESS=$NEXT_PUBLIC_VAULT_ADDRESS
ENV NEXT_PUBLIC_PRICE_FEED_ADDRESS=$NEXT_PUBLIC_PRICE_FEED_ADDRESS
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL
ENV NEXT_PUBLIC_BASE_TESTNET_RPC_URL=$NEXT_PUBLIC_BASE_TESTNET_RPC_URL

# Build the application
RUN npm run build

# Runtime stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Add non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy necessary files
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Set correct permissions
USER nextjs

# Expose port
EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

# Run the application
CMD ["node", "server.js"]
