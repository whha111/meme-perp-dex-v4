package keeper

import (
	"context"
	"time"

	"go.uber.org/zap"
	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/model"
	"github.com/memeperp/backend/internal/pkg/config"
	"github.com/memeperp/backend/internal/pkg/database"
	"github.com/memeperp/backend/internal/repository"
)

// OrderKeeper monitors and executes limit orders and algo orders
type OrderKeeper struct {
	db         *gorm.DB
	cache      *database.Cache
	cfg        *config.BlockchainConfig
	logger     *zap.Logger
	orderRepo  *repository.OrderRepository
}

func NewOrderKeeper(db *gorm.DB, cache *database.Cache, cfg *config.BlockchainConfig, logger *zap.Logger) *OrderKeeper {
	return &OrderKeeper{
		db:        db,
		cache:     cache,
		cfg:       cfg,
		logger:    logger,
		orderRepo: repository.NewOrderRepository(db),
	}
}

func (k *OrderKeeper) Start(ctx context.Context) {
	k.logger.Info("Order keeper started")

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			k.logger.Info("Order keeper stopped")
			return
		case <-ticker.C:
			k.checkAlgoOrders(ctx)
		}
	}
}

func (k *OrderKeeper) checkAlgoOrders(ctx context.Context) {
	// Get all pending algo orders
	orders, err := k.orderRepo.GetAllPendingAlgo()
	if err != nil {
		k.logger.Error("Failed to get pending algo orders", zap.Error(err))
		return
	}

	for _, order := range orders {
		// Get current mark price
		markPriceStr, err := k.cache.GetMarkPrice(ctx, order.InstID)
		if err != nil {
			continue
		}

		markPrice, err := model.NewDecimalFromString(markPriceStr)
		if err != nil {
			continue
		}

		// Check if any trigger conditions are met
		triggered, triggerType := k.checkTriggers(&order, markPrice)
		if triggered {
			k.logger.Info("Algo order triggered",
				zap.String("algoId", order.AlgoID),
				zap.String("type", triggerType),
				zap.String("markPrice", markPrice.String()))

			if err := k.executeAlgoOrder(&order, markPrice, triggerType); err != nil {
				k.logger.Error("Failed to execute algo order",
					zap.String("algoId", order.AlgoID),
					zap.Error(err))
			}
		}
	}
}

func (k *OrderKeeper) checkTriggers(order *model.AlgoOrder, markPrice model.Decimal) (bool, string) {
	// Check take profit
	if !order.TpTriggerPx.IsZero() {
		if order.PosSide == model.PosSideLong {
			// Long TP: trigger when price >= trigger price
			if markPrice.GreaterThanOrEqual(order.TpTriggerPx) {
				return true, "tp"
			}
		} else {
			// Short TP: trigger when price <= trigger price
			if markPrice.LessThanOrEqual(order.TpTriggerPx) {
				return true, "tp"
			}
		}
	}

	// Check stop loss
	if !order.SlTriggerPx.IsZero() {
		if order.PosSide == model.PosSideLong {
			// Long SL: trigger when price <= trigger price
			if markPrice.LessThanOrEqual(order.SlTriggerPx) {
				return true, "sl"
			}
		} else {
			// Short SL: trigger when price >= trigger price
			if markPrice.GreaterThanOrEqual(order.SlTriggerPx) {
				return true, "sl"
			}
		}
	}

	return false, ""
}

// P3-P3: NOTE — This is a secondary/redundant TP/SL checker.
// Primary TP/SL execution happens in the matching engine (server.ts checkTakeProfitStopLoss L2866).
// This keeper only updates DB state to "triggered" — it does NOT execute actual trades.
// The matching engine handles real-time price monitoring and position closure.
// This code remains as a safety net for DB-only mode (when engine is unavailable).
func (k *OrderKeeper) executeAlgoOrder(order *model.AlgoOrder, markPrice model.Decimal, triggerType string) error {
	now := time.Now().UnixMilli()

	// Determine order price
	var ordPx model.Decimal
	if triggerType == "tp" {
		ordPx = order.TpOrdPx
	} else {
		ordPx = order.SlOrdPx
	}

	// -1 means market order
	if ordPx.Equal(model.NewDecimalFromInt(-1)) || ordPx.IsZero() {
		ordPx = markPrice
	}

	// DB state update only — actual trade execution is in matching engine
	order.State = model.AlgoStateTriggered
	order.TriggerPx = markPrice
	order.ActualPx = ordPx
	order.ActualSz = order.Sz
	order.UTime = now
	order.TriggerTime = now

	return k.orderRepo.UpdateAlgo(order)
}
