package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/memeperp/backend/internal/keeper"
	"github.com/memeperp/backend/internal/pkg/config"
	"github.com/memeperp/backend/internal/pkg/database"
)

func main() {
	// Load config
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize logger — AUDIT-FIX GO-H03: don't discard error, nil logger → panic
	var logger *zap.Logger
	var logErr error
	if cfg.Server.Mode == "debug" {
		logger, logErr = zap.NewDevelopment()
	} else {
		logger, logErr = zap.NewProduction()
	}
	if logErr != nil || logger == nil {
		log.Fatalf("Failed to initialize logger: %v", logErr)
	}
	defer logger.Sync()

	// Connect to PostgreSQL
	db, err := database.NewPostgres(cfg.Database)
	if err != nil {
		logger.Fatal("Failed to connect to database", zap.Error(err))
	}

	// Connect to Redis
	redis, err := database.NewRedis(cfg.Redis)
	if err != nil {
		logger.Fatal("Failed to connect to Redis", zap.Error(err))
	}
	cache := database.NewCache(redis)

	// Context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Create and start keepers
	liquidationKeeper := keeper.NewLiquidationKeeper(db, cache, &cfg.Blockchain, logger, cfg.MatchingEngine.URL)
	fundingKeeper := keeper.NewFundingKeeper(db, cache, &cfg.Blockchain, logger)
	orderKeeper := keeper.NewOrderKeeper(db, cache, &cfg.Blockchain, logger)

	// Start all keepers
	go liquidationKeeper.Start(ctx)
	go fundingKeeper.Start(ctx)
	go orderKeeper.Start(ctx)

	logger.Info("Keeper services started")

	// Health check HTTP server for Docker healthcheck
	healthPort := os.Getenv("HEALTH_PORT")
	if healthPort == "" {
		healthPort = "8082"
	}
	startTime := time.Now()
	healthMux := http.NewServeMux()
	healthMux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		uptime := int(time.Since(startTime).Seconds())
		fmt.Fprintf(w, `{"status":"ok","service":"keeper","uptime":%d}`, uptime)
	})
	healthServer := &http.Server{Addr: ":" + healthPort, Handler: healthMux}
	go func() {
		logger.Info("Health server started", zap.String("port", healthPort))
		if err := healthServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Warn("Health server error", zap.Error(err))
		}
	}()

	// Wait for shutdown signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	logger.Info("Shutting down keepers...")
	cancel()

	// Shutdown health server
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer shutdownCancel()
	healthServer.Shutdown(shutdownCtx)

	// Give keepers time to finish
	time.Sleep(2 * time.Second)
	logger.Info("Keepers stopped")
}
