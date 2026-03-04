package service

import (
	"time"

	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/model"
	"github.com/memeperp/backend/internal/pkg/database"
	"github.com/memeperp/backend/internal/pkg/errors"
	"github.com/memeperp/backend/internal/repository"
)

type AccountService struct {
	db           *gorm.DB // AUDIT-FIX GO-C05: store DB reference for bill repo
	userRepo     *repository.UserRepository
	balanceRepo  *repository.BalanceRepository
	positionRepo *repository.PositionRepository
	cache        *database.Cache
}

func NewAccountService(
	db *gorm.DB, // AUDIT-FIX GO-C05: pass DB for bill repo
	userRepo *repository.UserRepository,
	balanceRepo *repository.BalanceRepository,
	positionRepo *repository.PositionRepository,
	cache *database.Cache,
) *AccountService {
	return &AccountService{
		db:           db,
		userRepo:     userRepo,
		balanceRepo:  balanceRepo,
		positionRepo: positionRepo,
		cache:        cache,
	}
}

func (s *AccountService) GetBalance(userID int64, ccy string) (*model.AccountBalance, error) {
	balances, err := s.balanceRepo.GetByUser(userID)
	if err != nil {
		return nil, err
	}

	// Get all positions to calculate unrealized PnL
	positions, err := s.positionRepo.GetByUser(userID, "")
	if err != nil && err != gorm.ErrRecordNotFound {
		return nil, err
	}

	// Calculate totals
	totalEq := model.Zero()
	totalUpl := model.Zero()
	totalImr := model.Zero()
	totalMmr := model.Zero()

	for _, pos := range positions {
		totalUpl = totalUpl.Add(pos.Upl)
		totalImr = totalImr.Add(pos.Imr)
		totalMmr = totalMmr.Add(pos.Mmr)
	}

	var details []model.BalanceDetail
	for _, bal := range balances {
		if ccy != "" && bal.Ccy != ccy {
			continue
		}
		eq := bal.CashBal.Add(bal.Upl)
		totalEq = totalEq.Add(eq)

		details = append(details, model.BalanceDetail{
			Ccy:       bal.Ccy,
			Eq:        eq,
			CashBal:   bal.CashBal,
			UTime:     bal.UTime,
			AvailEq:   bal.AvailBal,
			DisEq:     eq,
			AvailBal:  bal.AvailBal,
			FrozenBal: bal.FrozenBal,
			OrdFrozen: bal.OrdFrozen,
			Upl:       bal.Upl,
		})
	}

	// Calculate margin ratio
	mgnRatio := model.Zero()
	if !totalMmr.IsZero() {
		mgnRatio = totalEq.Div(totalMmr)
	}

	return &model.AccountBalance{
		TotalEq:  totalEq,
		AdjEq:    totalEq,
		Imr:      totalImr,
		Mmr:      totalMmr,
		MgnRatio: mgnRatio,
		UTime:    time.Now().UnixMilli(),
		Details:  details,
	}, nil
}

func (s *AccountService) GetPositions(userID int64, instID string) ([]model.Position, error) {
	return s.positionRepo.GetByUser(userID, instID)
}

func (s *AccountService) GetPosition(userID int64, posID string) (*model.Position, error) {
	pos, err := s.positionRepo.GetByPosID(posID)
	if err != nil {
		return nil, errors.New(errors.CodePositionNotFound)
	}
	if pos.UserID != userID {
		return nil, errors.New(errors.CodePermissionDenied)
	}
	return pos, nil
}

func (s *AccountService) SetLeverage(userID int64, instID string, lever int16, mgnMode, posSide string) error {
	// AUDIT-FIX M-26: Align max leverage with matching engine (10x).
	// Previously allowed 100x which mismatched the engine's 10x limit.
	if lever < 1 || lever > 10 {
		return errors.New(errors.CodeInvalidLeverage)
	}

	// Check if user has open positions
	positions, err := s.positionRepo.GetByUser(userID, instID)
	if err != nil && err != gorm.ErrRecordNotFound {
		return err
	}

	for _, pos := range positions {
		if !pos.Pos.IsZero() && pos.MgnMode == mgnMode {
			// If there's an open position, we can only increase leverage
			if lever < pos.Lever {
				return errors.Newf(errors.CodeCannotAdjustMargin, "cannot decrease leverage with open position")
			}
		}
	}

	// Save leverage setting
	setting := &model.LeverageSetting{
		UserID:  userID,
		InstID:  instID,
		MgnMode: mgnMode,
		PosSide: posSide,
		Lever:   lever,
		UTime:   time.Now().UnixMilli(),
	}

	return s.positionRepo.SetLeverageSetting(setting)
}

func (s *AccountService) GetLeverageInfo(userID int64, instID, mgnMode string) (*model.LeverageSetting, error) {
	setting, err := s.positionRepo.GetLeverageSetting(userID, instID, mgnMode, "")
	if err == gorm.ErrRecordNotFound {
		// Return default leverage
		return &model.LeverageSetting{
			InstID:  instID,
			MgnMode: mgnMode,
			Lever:   20, // Default leverage
			UTime:   time.Now().UnixMilli(),
		}, nil
	}
	return setting, err
}

func (s *AccountService) AdjustMargin(userID int64, instID, posSide, adjustType string, amount model.Decimal) error {
	// Get position
	pos, err := s.positionRepo.GetByUserAndInst(userID, instID, posSide, model.TdModeIsolated)
	if err != nil {
		return errors.New(errors.CodePositionNotFound)
	}

	// Platform uses BNB on BSC
	balance, err := s.balanceRepo.GetByUserAndCcy(userID, "ETH")
	if err != nil {
		return errors.New(errors.CodeInsufficientBalance)
	}

	if adjustType == "add" {
		// Check available balance
		if balance.AvailBal.LessThan(amount) {
			return errors.New(errors.CodeInsufficientBalance)
		}

		// Deduct from available balance
		if err := s.balanceRepo.FreezeBalance(userID, "ETH", amount); err != nil {
			return err
		}

		// Add to position margin
		pos.Margin = pos.Margin.Add(amount)
	} else if adjustType == "reduce" {
		// Check if we can reduce margin
		minMargin := pos.Mmr // Minimum required margin
		if pos.Margin.Sub(amount).LessThan(minMargin) {
			return errors.New(errors.CodeCannotAdjustMargin)
		}

		// Reduce position margin
		pos.Margin = pos.Margin.Sub(amount)

		// Return to available balance
		if err := s.balanceRepo.UnfreezeBalance(userID, "ETH", amount); err != nil {
			return err
		}
	} else {
		return errors.New(errors.CodeEmptyRequest)
	}

	// Recalculate liquidation price
	pos.LiqPx = calculateLiquidationPrice(pos)
	pos.UTime = time.Now().UnixMilli()

	return s.positionRepo.Update(pos)
}

func (s *AccountService) GetBills(userID int64, instType, ccy string, billType int16, after, before int64, limit int) ([]model.Bill, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}

	billRepo := repository.NewBillRepository(s.db) // AUDIT-FIX GO-C05: use injected DB, not nil
	return billRepo.GetByUser(userID, instType, ccy, billType, after, before, limit)
}

// calculateLiquidationPrice calculates the estimated liquidation price
func calculateLiquidationPrice(pos *model.Position) model.Decimal {
	if pos.Pos.IsZero() {
		return model.Zero()
	}

	// Simplified liquidation price calculation
	// For long: liqPx = avgPx * (1 - 1/lever + mmr)
	// For short: liqPx = avgPx * (1 + 1/lever - mmr)
	lever := model.NewDecimalFromInt(int64(pos.Lever))
	one := model.NewDecimalFromInt(1)
	mmrRate := model.NewDecimalFromFloat(0.005) // 0.5% maintenance margin rate

	if pos.PosSide == model.PosSideLong {
		factor := one.Sub(one.Div(lever)).Add(mmrRate)
		return pos.AvgPx.Mul(factor)
	} else {
		factor := one.Add(one.Div(lever)).Sub(mmrRate)
		return pos.AvgPx.Mul(factor)
	}
}
