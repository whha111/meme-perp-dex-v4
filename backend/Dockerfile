# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Install dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o main ./cmd/api

# Runtime stage
FROM alpine:3.18

WORKDIR /app

# Install ca-certificates for HTTPS
RUN apk --no-cache add ca-certificates wget

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy binary from builder
COPY --from=builder /app/main .
COPY --from=builder /app/configs ./configs

# Set ownership and switch to non-root user
RUN chown -R appuser:appgroup /app
USER appuser

# Expose port
EXPOSE 8080

# Run the application
CMD ["./main"]
