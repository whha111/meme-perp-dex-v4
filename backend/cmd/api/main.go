package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ethereum/go-ethereum/ethclient"
	"go.uber.org/zap"

	"github.com/memeperp/backend/internal/api"
	"github.com/memeperp/backend/internal/keeper"
	"github.com/memeperp/backend/internal/pkg/config"
	"github.com/memeperp/backend/internal/pkg/database"
	"github.com/memeperp/backend/internal/pkg/jwt"
	"github.com/memeperp/backend/internal/pkg/nonce"
)

func main() {
	// Load config
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Initialize logger — P2: check err instead of ignoring
	var logger *zap.Logger
	var logErr error
	if cfg.Server.Mode == "debug" {
		logger, logErr = zap.NewDevelopment()
	} else {
		logger, logErr = zap.NewProduction()
	}
	if logErr != nil {
		log.Fatalf("Failed to initialize logger: %v", logErr)
	}
	defer logger.Sync()

	// Connect to PostgreSQL
	db, err := database.NewPostgres(cfg.Database)
	if err != nil {
		logger.Fatal("Failed to connect to database", zap.Error(err))
	}

	// Auto migrate
	if err := database.AutoMigrate(db); err != nil {
		logger.Fatal("Failed to migrate database", zap.Error(err))
	}

	// Initialize instruments
	if err := database.InitializeInstruments(db); err != nil {
		logger.Warn("Failed to initialize instruments", zap.Error(err))
	}

	// Connect to Redis (optional for development)
	redis, err := database.NewRedis(cfg.Redis)
	if err != nil {
		logger.Warn("Redis not available, running without cache", zap.Error(err))
		redis = nil
	}

	// Initialize JWT manager
	jwtManager := jwt.NewManager(cfg.JWT.Secret, cfg.JWT.Expiration)
	logger.Info("JWT manager initialized")

	// Initialize Ethereum client for nonce management
	var nonceManager *nonce.Manager
	if redis != nil && cfg.Blockchain.RPCURL != "" {
		ethClient, err := ethclient.Dial(cfg.Blockchain.RPCURL)
		if err != nil {
			logger.Warn("Failed to connect to Ethereum client for nonce management", zap.Error(err))
		} else {
			nonceManager = nonce.NewManager(redis, ethClient, logger)
			logger.Info("Nonce manager initialized with Redis persistence")
		}
	}

	// Create router and WebSocket hub with new dependencies
	routerResult := api.NewRouter(cfg, db, redis, jwtManager, nonceManager, logger)

	// Create context for WebSocket hub
	ctx, cancel := context.WithCancel(context.Background())

	// Start WebSocket hub
	api.StartWSHub(routerResult.WSHub, ctx)
	logger.Info("WebSocket hub started")

	// Initialize and start keeper services (only if Redis is available)
	var keeperManager *keeper.Manager
	if redis != nil {
		keeperManager = keeper.NewManager(cfg, db, redis, logger)
		keeperManager.Initialize()
		keeperManager.Start()
		logger.Info("Keeper services started")
	}

	// Create server
	srv := &http.Server{
		Addr:         cfg.Server.Addr,
		Handler:      routerResult.Engine,
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
	}

	// Start server
	// P1: TLS 由反向代理 (Nginx) 终止。生产部署必须配置 Nginx TLS → 此 HTTP 服务器。
	go func() {
		if cfg.Server.Mode != "debug" {
			logger.Info("API Server starting (production — ensure Nginx TLS reverse proxy)",
				zap.String("addr", cfg.Server.Addr))
		} else {
			logger.Info("API Server starting", zap.String("addr", cfg.Server.Addr))
		}
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Fatal("Failed to start server", zap.Error(err))
		}
	}()

	// Graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("Shutting down server...")

	// Stop keeper services
	if keeperManager != nil {
		keeperManager.Stop()
	}

	// Cancel WebSocket hub context
	cancel()

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Fatal("Server forced to shutdown", zap.Error(err))
	}

	logger.Info("Server exited")
}
