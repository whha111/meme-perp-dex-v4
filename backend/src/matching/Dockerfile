# Matching Engine Dockerfile
FROM oven/bun:1 AS base

WORKDIR /app

# Copy package files
COPY matching/package.json ./matching/

# Install dependencies
WORKDIR /app/matching
RUN bun install --frozen-lockfile || bun install

# Copy source code (matching + spot directories, maintaining relative paths)
WORKDIR /app
COPY matching/ ./matching/
COPY spot/ ./spot/

# Expose port
EXPOSE 8081

ENV PORT=8081

# Create non-root user (Debian-based image uses groupadd/useradd)
RUN groupadd --system --gid 1001 appgroup && \
    useradd --system --uid 1001 --gid appgroup --no-create-home appuser
RUN chown -R appuser:appgroup /app
USER appuser

# Health check
# Health check (use bun fetch since wget may not be available in Debian slim)
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:8081/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Run the application from matching directory
WORKDIR /app/matching
CMD ["bun", "run", "server.ts"]
