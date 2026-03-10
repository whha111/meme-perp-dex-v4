package api

import (
	"context"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/api/handler"
	"github.com/memeperp/backend/internal/api/middleware"
	"github.com/memeperp/backend/internal/pkg/config"
	"github.com/memeperp/backend/internal/pkg/database"
	"github.com/memeperp/backend/internal/pkg/jwt"
	"github.com/memeperp/backend/internal/pkg/nonce"
	"github.com/memeperp/backend/internal/repository"
	"github.com/memeperp/backend/internal/service"
	"github.com/memeperp/backend/internal/ws"
)

type Router struct {
	engine       *gin.Engine
	db           *gorm.DB
	redis        *redis.Client
	cache        *database.Cache
	cfg          *config.Config
	logger       *zap.Logger
	rateLimiter  *middleware.RateLimiter
	wsHub        *ws.Hub
	jwtManager   *jwt.Manager
	nonceManager *nonce.Manager
}

// RouterResult contains the router engine and WebSocket hub
type RouterResult struct {
	Engine *gin.Engine
	WSHub  *ws.Hub
}

func NewRouter(cfg *config.Config, db *gorm.DB, redis *redis.Client, jwtManager *jwt.Manager, nonceManager *nonce.Manager, logger *zap.Logger) *RouterResult {
	if cfg.Server.Mode == "release" {
		gin.SetMode(gin.ReleaseMode)
	}

	engine := gin.New()
	cache := database.NewCache(redis)

	// Initialize WebSocket hub with JWT manager
	wsHub := ws.NewHub(cache, jwtManager, logger)

	r := &Router{
		engine:       engine,
		db:           db,
		redis:        redis,
		cache:        cache,
		cfg:          cfg,
		logger:       logger,
		rateLimiter:  middleware.NewRateLimiter(cache, cfg.RateLimit.PublicLimit, cfg.RateLimit.PrivateLimit, cfg.RateLimit.OrderLimit),
		wsHub:        wsHub,
		jwtManager:   jwtManager,
		nonceManager: nonceManager,
	}

	r.setupMiddleware()
	r.setupRoutes()

	return &RouterResult{
		Engine: engine,
		WSHub:  wsHub,
	}
}

// StartWSHub starts the WebSocket hub in a goroutine
func StartWSHub(hub *ws.Hub, ctx context.Context) {
	go hub.Run(ctx)
}

func (r *Router) setupMiddleware() {
	r.engine.Use(gin.Recovery())
	r.engine.Use(middleware.CORSMiddleware(r.cfg)) // Pass config for CORS whitelist
	r.engine.Use(middleware.LoggerMiddleware(r.logger))
}

func (r *Router) setupRoutes() {
	// Initialize repositories
	userRepo := repository.NewUserRepository(r.db)
	instrumentRepo := repository.NewInstrumentRepository(r.db)
	positionRepo := repository.NewPositionRepository(r.db)
	balanceRepo := repository.NewBalanceRepository(r.db)
	tradeRepo := repository.NewTradeRepository(r.db)
	candleRepo := repository.NewCandleRepository(r.db)
	fundingRepo := repository.NewFundingRateRepository(r.db)
	billRepo := repository.NewBillRepository(r.db)
	liquidationRepo := repository.NewLiquidationRepository(r.db)
	tokenMetadataRepo := repository.NewTokenMetadataRepository(r.db)

	// Initialize services
	marketService := service.NewMarketService(instrumentRepo, tradeRepo, candleRepo, fundingRepo, tokenMetadataRepo, r.cache)
	accountService := service.NewAccountService(r.db, userRepo, balanceRepo, positionRepo, r.cache) // AUDIT-FIX GO-C05: pass DB for bill repo
	positionService := service.NewPositionService(positionRepo, balanceRepo, instrumentRepo, billRepo, r.cache)
	liquidationService := service.NewLiquidationService(positionRepo, balanceRepo, instrumentRepo, liquidationRepo, billRepo, r.cache)

	// Initialize handlers with new dependencies
	authHandler := handler.NewAuthHandler(r.db, r.jwtManager)
	marketHandler := handler.NewMarketHandler(marketService, r.cfg.MatchingEngine.URL)
	accountHandler := handler.NewAccountHandler(accountService)
	positionHandler := handler.NewPositionHandler(positionService, liquidationService)
	wsHandler := handler.NewWebSocketHandler(r.wsHub, r.cfg, r.logger)
	healthHandler := handler.NewHealthHandler(r.db, r.redis, r.cfg.MatchingEngine.URL)
	tokenHandler := handler.NewTokenHandler(tokenMetadataRepo, instrumentRepo)

	// Keep services accessible for keeper
	_ = liquidationService // Will be used by keeper service

	// WebSocket endpoints
	r.engine.GET("/ws/public", wsHandler.HandlePublicWS)
	r.engine.GET("/ws/private", wsHandler.HandlePrivateWS)

	// API v1
	v1 := r.engine.Group("/api/v1")

	// Auth endpoints (no authentication required, but rate limited to prevent brute force)
	auth := v1.Group("/auth")
	auth.Use(r.rateLimiter.RateLimitMiddleware("public"))
	{
		auth.POST("/nonce", authHandler.GetNonce)
		auth.POST("/login", authHandler.Login)
	}

	// Public endpoints - Market data
	public := v1.Group("/public")
	public.Use(r.rateLimiter.RateLimitMiddleware("public"))
	{
		public.GET("/instruments", marketHandler.GetInstruments)
		public.GET("/time", marketHandler.GetServerTime)
	}

	// Market endpoints
	market := v1.Group("/market")
	market.Use(r.rateLimiter.RateLimitMiddleware("public"))
	{
		market.GET("/ticker", marketHandler.GetTicker)
		market.GET("/tickers", marketHandler.GetTickers)
		market.GET("/candles", marketHandler.GetCandles)
		market.GET("/books", marketHandler.GetOrderBook)
		market.GET("/trades", marketHandler.GetTrades)
		market.GET("/mark-price", marketHandler.GetMarkPrice)
		market.GET("/funding-rate", marketHandler.GetFundingRate)
		market.GET("/funding-rate-history", marketHandler.GetFundingRateHistory)
		market.GET("/liquidations", positionHandler.GetRecentLiquidations)
	}

	// Token endpoints
	token := v1.Group("/token")
	token.Use(r.rateLimiter.RateLimitMiddleware("public"))
	{
		// AUDIT-FIX GO-C03: POST /metadata 需要鉴权，防止任意 token 创建 + XSS
		token.POST("/metadata", middleware.AuthMiddleware(r.db), tokenHandler.CreateTokenMetadata)
		token.GET("/metadata", tokenHandler.GetTokenMetadata)
		token.GET("/metadata/all", tokenHandler.GetAllTokenMetadata)
	}

	// Private endpoints - require authentication
	// Account
	account := v1.Group("/account")
	account.Use(r.rateLimiter.RateLimitMiddleware("private"))
	account.Use(middleware.AuthMiddleware(r.db))
	{
		account.GET("/balance", accountHandler.GetBalance)
		account.GET("/positions", positionHandler.GetPositions)
		account.GET("/position", positionHandler.GetPosition)
		account.GET("/positions-history", positionHandler.GetPositionHistory)
		account.POST("/set-leverage", accountHandler.SetLeverage)
		account.GET("/leverage-info", accountHandler.GetLeverageInfo)
		account.POST("/position/margin-balance", accountHandler.AdjustMargin)
		account.GET("/bills", accountHandler.GetBills)
		account.GET("/liquidations", positionHandler.GetLiquidationHistory)
	}

	// Health check endpoints
	r.engine.GET("/health", healthHandler.GetHealth)
	r.engine.GET("/health/all", healthHandler.GetAggregatedHealth)
}
