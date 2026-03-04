package repository

import (
	"time"

	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/model"
)

type TradeRepository struct {
	db *gorm.DB
}

func NewTradeRepository(db *gorm.DB) *TradeRepository {
	return &TradeRepository{db: db}
}

func (r *TradeRepository) Create(trade *model.Trade) error {
	return r.db.Create(trade).Error
}

func (r *TradeRepository) GetByInstID(instID string, limit int) ([]model.Trade, error) {
	var trades []model.Trade
	if err := r.db.Where("inst_id = ?", instID).Order("ts DESC").Limit(limit).Find(&trades).Error; err != nil {
		return nil, err
	}
	return trades, nil
}

func (r *TradeRepository) GetByTimeRange(instID string, startTime, endTime int64, limit int) ([]model.Trade, error) {
	var trades []model.Trade
	query := r.db.Where("inst_id = ?", instID)
	if startTime > 0 {
		query = query.Where("ts >= ?", startTime)
	}
	if endTime > 0 {
		query = query.Where("ts <= ?", endTime)
	}
	if err := query.Order("ts DESC").Limit(limit).Find(&trades).Error; err != nil {
		return nil, err
	}
	return trades, nil
}

func (r *TradeRepository) GetLatest(instID string) (*model.Trade, error) {
	var trade model.Trade
	if err := r.db.Where("inst_id = ?", instID).Order("ts DESC").First(&trade).Error; err != nil {
		return nil, err
	}
	return &trade, nil
}

func (r *TradeRepository) Get24hStats(instID string) (*Trade24hStats, error) {
	var stats Trade24hStats
	ts24hAgo := currentTimeMillis() - 24*60*60*1000

	err := r.db.Model(&model.Trade{}).
		Where("inst_id = ? AND ts >= ?", instID, ts24hAgo).
		Select("MIN(px) as low, MAX(px) as high, SUM(sz) as volume, SUM(sz * px) as volume_ccy").
		Scan(&stats).Error
	if err != nil {
		return nil, err
	}

	// Get opening price
	var openTrade model.Trade
	if err := r.db.Where("inst_id = ? AND ts >= ?", instID, ts24hAgo).Order("ts ASC").First(&openTrade).Error; err == nil {
		stats.Open = openTrade.Px
	}

	return &stats, nil
}

type Trade24hStats struct {
	Open      model.Decimal
	High      model.Decimal
	Low       model.Decimal
	Volume    model.Decimal
	VolumeCcy model.Decimal
}

func currentTimeMillis() int64 {
	// AUDIT-FIX GO-C03: 原实现返回常量 0，导致 Get24hStats 查询所有历史交易
	return time.Now().UnixMilli()
}
