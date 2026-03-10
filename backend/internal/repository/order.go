package repository

import (
	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/model"
)

type OrderRepository struct {
	db *gorm.DB
}

func NewOrderRepository(db *gorm.DB) *OrderRepository {
	return &OrderRepository{db: db}
}

func (r *OrderRepository) GetByOrdID(ordID string) (*model.Order, error) {
	var order model.Order
	if err := r.db.Where("ord_id = ?", ordID).First(&order).Error; err != nil {
		return nil, err
	}
	return &order, nil
}

func (r *OrderRepository) GetByClOrdID(userID int64, clOrdID string) (*model.Order, error) {
	var order model.Order
	if err := r.db.Where("user_id = ? AND cl_ord_id = ?", userID, clOrdID).First(&order).Error; err != nil {
		return nil, err
	}
	return &order, nil
}

func (r *OrderRepository) Create(order *model.Order) error {
	return r.db.Create(order).Error
}

func (r *OrderRepository) Update(order *model.Order) error {
	return r.db.Save(order).Error
}

func (r *OrderRepository) GetPendingByUser(userID int64, instID string, limit int) ([]model.Order, error) {
	// P3-78: Cap query limit to prevent unbounded queries
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	var orders []model.Order
	query := r.db.Where("user_id = ? AND state IN ?", userID, []string{model.OrderStateLive, model.OrderStatePartiallyFilled})
	if instID != "" {
		query = query.Where("inst_id = ?", instID)
	}
	if err := query.Order("c_time DESC").Limit(limit).Find(&orders).Error; err != nil {
		return nil, err
	}
	return orders, nil
}

func (r *OrderRepository) GetHistoryByUser(userID int64, instID string, after, before int64, limit int) ([]model.Order, error) {
	// P3-78: Cap query limit to prevent unbounded queries
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	var orders []model.Order
	query := r.db.Where("user_id = ? AND state IN ?", userID, []string{model.OrderStateFilled, model.OrderStateCanceled})
	if instID != "" {
		query = query.Where("inst_id = ?", instID)
	}
	if after > 0 {
		query = query.Where("c_time < ?", after)
	}
	if before > 0 {
		query = query.Where("c_time > ?", before)
	}
	if err := query.Order("c_time DESC").Limit(limit).Find(&orders).Error; err != nil {
		return nil, err
	}
	return orders, nil
}

func (r *OrderRepository) GetLiveOrders(instID string) ([]model.Order, error) {
	var orders []model.Order
	if err := r.db.Where("inst_id = ? AND state IN ?", instID, []string{model.OrderStateLive, model.OrderStatePartiallyFilled}).
		Order("px ASC").Find(&orders).Error; err != nil {
		return nil, err
	}
	return orders, nil
}

func (r *OrderRepository) CancelAllByUser(userID int64, instID string) (int64, error) {
	query := r.db.Model(&model.Order{}).Where("user_id = ? AND state IN ?", userID, []string{model.OrderStateLive, model.OrderStatePartiallyFilled})
	if instID != "" {
		query = query.Where("inst_id = ?", instID)
	}
	result := query.Update("state", model.OrderStateCanceled)
	return result.RowsAffected, result.Error
}

// Algo order methods
func (r *OrderRepository) CreateAlgo(order *model.AlgoOrder) error {
	return r.db.Create(order).Error
}

func (r *OrderRepository) GetAlgoByID(algoID string) (*model.AlgoOrder, error) {
	var order model.AlgoOrder
	if err := r.db.Where("algo_id = ?", algoID).First(&order).Error; err != nil {
		return nil, err
	}
	return &order, nil
}

func (r *OrderRepository) UpdateAlgo(order *model.AlgoOrder) error {
	return r.db.Save(order).Error
}

func (r *OrderRepository) GetPendingAlgoByUser(userID int64, instID string, limit int) ([]model.AlgoOrder, error) {
	var orders []model.AlgoOrder
	query := r.db.Where("user_id = ? AND state = ?", userID, model.AlgoStateLive)
	if instID != "" {
		query = query.Where("inst_id = ?", instID)
	}
	if err := query.Order("c_time DESC").Limit(limit).Find(&orders).Error; err != nil {
		return nil, err
	}
	return orders, nil
}

func (r *OrderRepository) GetAllPendingAlgo() ([]model.AlgoOrder, error) {
	var orders []model.AlgoOrder
	if err := r.db.Where("state = ?", model.AlgoStateLive).Find(&orders).Error; err != nil {
		return nil, err
	}
	return orders, nil
}
