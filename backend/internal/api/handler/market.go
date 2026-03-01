package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/memeperp/backend/internal/api/response"
	"github.com/memeperp/backend/internal/model"
	"github.com/memeperp/backend/internal/pkg/errors"
	"github.com/memeperp/backend/internal/service"
)

type MarketHandler struct {
	marketService      *service.MarketService
	matchingEngineURL  string
}

func NewMarketHandler(marketService *service.MarketService, matchingEngineURL string) *MarketHandler {
	return &MarketHandler{
		marketService:     marketService,
		matchingEngineURL: matchingEngineURL,
	}
}

// GetInstruments returns all available instruments
// GET /api/v1/public/instruments
func (h *MarketHandler) GetInstruments(c *gin.Context) {
	instType := c.Query("instType")

	instruments, err := h.marketService.GetInstruments(instType)
	if err != nil {
		response.Error(c, err)
		return
	}

	response.Success(c, instruments)
}

// GetServerTime returns server time
// GET /api/v1/public/time
func (h *MarketHandler) GetServerTime(c *gin.Context) {
	response.Success(c, gin.H{
		"ts": h.marketService.GetServerTime(),
	})
}

// GetTicker returns ticker for a single instrument
// GET /api/v1/market/ticker
func (h *MarketHandler) GetTicker(c *gin.Context) {
	instID := c.Query("instId")
	if instID == "" {
		response.Error(c, errors.New(errors.CodeEmptyRequest))
		return
	}

	ticker, err := h.marketService.GetTicker(instID)
	if err != nil {
		response.Error(c, err)
		return
	}

	response.Success(c, []model.Ticker{*ticker})
}

// GetTickers returns tickers for all instruments
// GET /api/v1/market/tickers
func (h *MarketHandler) GetTickers(c *gin.Context) {
	tickers, err := h.marketService.GetAllTickers()
	if err != nil {
		response.Error(c, err)
		return
	}

	response.Success(c, tickers)
}

// GetCandles returns K-line data
// GET /api/v1/market/candles
func (h *MarketHandler) GetCandles(c *gin.Context) {
	instID := c.Query("instId")
	if instID == "" {
		response.Error(c, errors.New(errors.CodeEmptyRequest))
		return
	}

	bar := c.DefaultQuery("bar", model.Bar1m)
	after := parseIntParam(c.Query("after"), 0)
	before := parseIntParam(c.Query("before"), 0)
	limit := parseIntParam(c.Query("limit"), 100)

	candles, err := h.marketService.GetCandles(instID, bar, after, before, int(limit))
	if err != nil {
		response.Error(c, err)
		return
	}

	// Convert to array format for response
	var result [][]interface{}
	for _, candle := range candles {
		result = append(result, []interface{}{
			strconv.FormatInt(candle.Ts, 10),
			candle.O.String(),
			candle.H.String(),
			candle.L.String(),
			candle.C.String(),
			candle.Vol.String(),
			candle.VolCcy.String(),
			strconv.Itoa(int(candle.Confirm)),
		})
	}

	response.Success(c, result)
}

// MatchingEngineOrderBookResponse represents the orderbook response from Matching Engine
type MatchingEngineOrderBookResponse struct {
	Longs []struct {
		Price string `json:"price"`
		Size  string `json:"size"`
		Count int    `json:"count"`
	} `json:"longs"`
	Shorts []struct {
		Price string `json:"price"`
		Size  string `json:"size"`
		Count int    `json:"count"`
	} `json:"shorts"`
	LastPrice string `json:"lastPrice"`
}

// GetOrderBook returns order book depth
// GET /api/v1/market/books
// ARCHITECTURAL NOTE: This endpoint proxies to the Matching Engine (port 8081)
// which maintains the real-time in-memory orderbook. This ensures single source of truth.
func (h *MarketHandler) GetOrderBook(c *gin.Context) {
	instID := c.Query("instId")
	if instID == "" {
		response.Error(c, errors.New(errors.CodeEmptyRequest))
		return
	}

	// Extract token address from instID (format: "TOKEN-USDC-SWAP")
	// For now, we need to map instID to token address
	// TODO: Add a proper instrument mapping service
	// Temporary: Pass instID directly to matching engine and let it handle

	// AUDIT-FIX GO-H06: Sanitize instID to prevent SSRF (path traversal, query injection)
	sanitizedInstID := strings.ReplaceAll(instID, "/", "")
	sanitizedInstID = strings.ReplaceAll(sanitizedInstID, "?", "")
	sanitizedInstID = strings.ReplaceAll(sanitizedInstID, "&", "")
	sanitizedInstID = strings.ReplaceAll(sanitizedInstID, "#", "")
	sanitizedInstID = strings.ReplaceAll(sanitizedInstID, "..", "")

	// Proxy request to Matching Engine
	url := fmt.Sprintf("%s/api/orderbook/%s", h.matchingEngineURL, sanitizedInstID)
	client := &http.Client{Timeout: 5 * time.Second} // AUDIT-FIX GO-H05: add timeout
	resp, err := client.Get(url)
	if err != nil {
		// If matching engine is unavailable, return empty orderbook
		response.Success(c, model.OrderBook{
			Asks: [][4]string{},
			Bids: [][4]string{},
			Ts:   time.Now().UnixMilli(),
		})
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Return empty orderbook on error
		response.Success(c, model.OrderBook{
			Asks: [][4]string{},
			Bids: [][4]string{},
			Ts:   time.Now().UnixMilli(),
		})
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		response.Success(c, model.OrderBook{
			Asks: [][4]string{},
			Bids: [][4]string{},
			Ts:   time.Now().UnixMilli(),
		})
		return
	}

	var meOrderBook MatchingEngineOrderBookResponse
	if err := json.Unmarshal(body, &meOrderBook); err != nil {
		response.Success(c, model.OrderBook{
			Asks: [][4]string{},
			Bids: [][4]string{},
			Ts:   time.Now().UnixMilli(),
		})
		return
	}

	// Transform Matching Engine format to Go Backend format
	// Longs (buy orders) → Bids
	// Shorts (sell orders) → Asks
	// Format: [price, size, deprecated, count]
	bids := make([][4]string, len(meOrderBook.Longs))
	for i, level := range meOrderBook.Longs {
		bids[i] = [4]string{
			level.Price,
			level.Size,
			"0", // Deprecated field
			strconv.Itoa(level.Count),
		}
	}

	asks := make([][4]string, len(meOrderBook.Shorts))
	for i, level := range meOrderBook.Shorts {
		asks[i] = [4]string{
			level.Price,
			level.Size,
			"0", // Deprecated field
			strconv.Itoa(level.Count),
		}
	}

	response.Success(c, model.OrderBook{
		Asks: asks,
		Bids: bids,
		Ts:   time.Now().UnixMilli(),
	})
}

// GetTrades returns recent trades
// GET /api/v1/market/trades
func (h *MarketHandler) GetTrades(c *gin.Context) {
	instID := c.Query("instId")
	if instID == "" {
		response.Error(c, errors.New(errors.CodeEmptyRequest))
		return
	}

	limit := parseIntParam(c.Query("limit"), 100)

	trades, err := h.marketService.GetTrades(instID, int(limit))
	if err != nil {
		response.Error(c, err)
		return
	}

	response.Success(c, trades)
}

// GetMarkPrice returns mark price
// GET /api/v1/market/mark-price
func (h *MarketHandler) GetMarkPrice(c *gin.Context) {
	instID := c.Query("instId")

	if instID != "" {
		price, err := h.marketService.GetMarkPrice(instID)
		if err != nil {
			response.Error(c, err)
			return
		}
		response.Success(c, []model.MarkPrice{*price})
	} else {
		prices, err := h.marketService.GetAllMarkPrices()
		if err != nil {
			response.Error(c, err)
			return
		}
		response.Success(c, prices)
	}
}

// GetFundingRate returns current funding rate
// GET /api/v1/market/funding-rate
func (h *MarketHandler) GetFundingRate(c *gin.Context) {
	instID := c.Query("instId")
	if instID == "" {
		response.Error(c, errors.New(errors.CodeEmptyRequest))
		return
	}

	info, err := h.marketService.GetFundingRate(instID)
	if err != nil {
		response.Error(c, err)
		return
	}

	response.Success(c, []model.FundingRateInfo{*info})
}

// GetFundingRateHistory returns funding rate history
// GET /api/v1/market/funding-rate-history
func (h *MarketHandler) GetFundingRateHistory(c *gin.Context) {
	instID := c.Query("instId")
	if instID == "" {
		response.Error(c, errors.New(errors.CodeEmptyRequest))
		return
	}

	after := parseIntParam(c.Query("after"), 0)
	before := parseIntParam(c.Query("before"), 0)
	limit := parseIntParam(c.Query("limit"), 100)

	rates, err := h.marketService.GetFundingRateHistory(instID, after, before, int(limit))
	if err != nil {
		response.Error(c, err)
		return
	}

	response.Success(c, rates)
}

func parseIntParam(s string, defaultVal int64) int64 {
	if s == "" {
		return defaultVal
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return defaultVal
	}
	return v
}
