package database

import (
	"fmt"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"

	"github.com/memeperp/backend/internal/model"
	"github.com/memeperp/backend/internal/pkg/config"
)

func NewPostgres(cfg config.DatabaseConfig) (*gorm.DB, error) {
	db, err := gorm.Open(postgres.Open(cfg.DSN()), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Info),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to connect to database: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get sql.DB: %w", err)
	}

	sqlDB.SetMaxIdleConns(cfg.MaxIdleConns)
	sqlDB.SetMaxOpenConns(cfg.MaxOpenConns)
	sqlDB.SetConnMaxLifetime(cfg.MaxLifetime)

	return db, nil
}

func AutoMigrate(db *gorm.DB) error {
	return db.AutoMigrate(
		&model.User{},
		&model.Instrument{},
		&model.Order{},
		&model.Position{},
		&model.Balance{},
		&model.Candle{},
		&model.Trade{},
		&model.FundingRate{},
		&model.Liquidation{},
		&model.Bill{},
		&model.LeverageSetting{},
		&model.AlgoOrder{},
		&model.TokenMetadata{},
	)
}

func InitializeInstruments(db *gorm.DB) error {
	instruments := []model.Instrument{
		{
			// AUDIT-FIX M-15: Base 链用 ETH 结算，不是 BNB
			InstID:    "MEME-ETH-PERP",
			InstType:  "PERP",
			BaseCcy:   "MEME",
			QuoteCcy:  "ETH",
			SettleCcy: "ETH",
			TickSz:    decimalFromString("0.000000001"),
			LotSz:     decimalFromString("1"),
			MinSz:     decimalFromString("1"),
			MaxLever:  100,
			State:     "live",
			ListTime:  time.Now().UnixMilli(),
		},
	}

	for _, inst := range instruments {
		result := db.Where("inst_id = ?", inst.InstID).FirstOrCreate(&inst)
		if result.Error != nil {
			return fmt.Errorf("failed to create instrument %s: %w", inst.InstID, result.Error)
		}
	}

	return nil
}

func decimalFromString(s string) model.Decimal {
	d, _ := model.NewDecimalFromString(s)
	return d
}
