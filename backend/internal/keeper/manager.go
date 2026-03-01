package keeper

import (
	"context"
	"sync"

	"github.com/redis/go-redis/v9"
	"go.uber.org/zap"
	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/pkg/config"
	"github.com/memeperp/backend/internal/pkg/database"
)

// Manager coordinates all keeper services
type Manager struct {
	db          *gorm.DB
	redis       *redis.Client
	cache       *database.Cache
	cfg         *config.Config
	logger      *zap.Logger
	keepers     []Keeper
	wg          sync.WaitGroup
	cancelFuncs []context.CancelFunc
}

// Keeper interface for all keeper services
type Keeper interface {
	Start(ctx context.Context)
}

// NewManager creates a new keeper manager
func NewManager(cfg *config.Config, db *gorm.DB, redis *redis.Client, logger *zap.Logger) *Manager {
	cache := database.NewCache(redis)

	return &Manager{
		db:     db,
		redis:  redis,
		cache:  cache,
		cfg:    cfg,
		logger: logger,
	}
}

// Initialize creates all keeper instances
func (m *Manager) Initialize() {
	// Price keeper - updates mark prices
	priceKeeper := NewPriceKeeper(m.db, m.cache, &m.cfg.Blockchain, m.logger.Named("price-keeper"))
	m.keepers = append(m.keepers, priceKeeper)

	// Liquidation keeper - monitors and triggers liquidations
	// Pass matching engine URL so keeper can query positions from engine (Mode 2)
	// instead of empty PostgreSQL. Falls back to DB if engine is unreachable.
	liqKeeper := NewLiquidationKeeper(m.db, m.cache, &m.cfg.Blockchain, m.logger.Named("liquidation-keeper"), m.cfg.MatchingEngine.URL)
	m.keepers = append(m.keepers, liqKeeper)

	// Funding keeper - settles funding rates
	// P3-P3: Pass matching engine URL (same pattern as LiquidationKeeper)
	fundingKeeper := NewFundingKeeper(m.db, m.cache, &m.cfg.Blockchain, m.logger.Named("funding-keeper"), m.cfg.MatchingEngine.URL)
	m.keepers = append(m.keepers, fundingKeeper)

	// Order keeper - executes algo orders
	orderKeeper := NewOrderKeeper(m.db, m.cache, &m.cfg.Blockchain, m.logger.Named("order-keeper"))
	m.keepers = append(m.keepers, orderKeeper)

	m.logger.Info("Initialized keepers", zap.Int("count", len(m.keepers)))
}

// Start starts all keeper services
func (m *Manager) Start() {
	m.logger.Info("Starting keeper services")

	for _, keeper := range m.keepers {
		ctx, cancel := context.WithCancel(context.Background())
		m.cancelFuncs = append(m.cancelFuncs, cancel)

		m.wg.Add(1)
		go func(k Keeper) {
			defer m.wg.Done()
			k.Start(ctx)
		}(keeper)
	}

	m.logger.Info("All keeper services started")
}

// Stop gracefully stops all keeper services
func (m *Manager) Stop() {
	m.logger.Info("Stopping keeper services")

	// Cancel all keeper contexts
	for _, cancel := range m.cancelFuncs {
		cancel()
	}

	// Wait for all keepers to finish
	m.wg.Wait()

	m.logger.Info("All keeper services stopped")
}
