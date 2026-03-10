package handler

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/model"
	"github.com/memeperp/backend/internal/pkg/jwt"
	"github.com/memeperp/backend/internal/repository"
)

// AuthHandler handles authentication endpoints
type AuthHandler struct {
	userRepo   *repository.UserRepository
	jwtManager *jwt.Manager
}

// NewAuthHandler creates a new auth handler
func NewAuthHandler(db *gorm.DB, jwtManager *jwt.Manager) *AuthHandler {
	return &AuthHandler{
		userRepo:   repository.NewUserRepository(db),
		jwtManager: jwtManager,
	}
}

// NonceRequest is the request for getting a nonce
type NonceRequest struct {
	Address string `json:"address" binding:"required"`
}

// NonceResponse is the response containing the nonce to sign
type NonceResponse struct {
	Nonce   string `json:"nonce"`
	Message string `json:"message"`
}

// LoginRequest is the request for login
type LoginRequest struct {
	Address   string `json:"address" binding:"required"`
	Signature string `json:"signature" binding:"required"`
	Nonce     string `json:"nonce" binding:"required"`
}

// LoginResponse is the response after successful login
type LoginResponse struct {
	APIKey       string `json:"apiKey"`
	APISecret    string `json:"apiSecret"`
	AccessToken  string `json:"accessToken"`   // JWT for WebSocket/REST
	RefreshToken string `json:"refreshToken"`  // JWT for token refresh
	Address      string `json:"address"`
	ExpiresAt    int64  `json:"expiresAt"`
}

// P1: nonce 存储 — sync.RWMutex 保护并发访问（生产环境应迁移到 Redis SETEX）
var (
	nonceStore = make(map[string]nonceInfo)
	nonceMu    sync.RWMutex
)

type nonceInfo struct {
	Nonce     string
	Message   string    // P1: 存储完整签名消息，确保 Login 验证时用相同的消息
	ExpiresAt time.Time
}

// M-25 FIX: 定期清理过期 nonce，防止内存无限增长
func init() {
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			nonceMu.Lock()
			now := time.Now()
			for addr, info := range nonceStore {
				if now.After(info.ExpiresAt) {
					delete(nonceStore, addr)
				}
			}
			nonceMu.Unlock()
		}
	}()
}

// GetNonce returns a nonce for the user to sign
// @Summary Get login nonce
// @Tags Auth
// @Accept json
// @Produce json
// @Param request body NonceRequest true "Address"
// @Success 200 {object} NonceResponse
// @Router /api/v1/auth/nonce [post]
func (h *AuthHandler) GetNonce(c *gin.Context) {
	var req NonceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40000",
			"msg":  "Invalid request: " + err.Error(),
			"data": nil,
		})
		return
	}

	// Validate address format
	if !common.IsHexAddress(req.Address) {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40001",
			"msg":  "Invalid Ethereum address",
			"data": nil,
		})
		return
	}

	// Generate random nonce
	nonce := generateNonce()
	message := fmt.Sprintf("Sign this message to login to MemePerpDEX.\n\nNonce: %s\nTimestamp: %d",
		nonce, time.Now().Unix())

	// Store nonce with expiration (5 minutes)
	nonceMu.Lock()
	nonceStore[strings.ToLower(req.Address)] = nonceInfo{
		Nonce:     nonce,
		Message:   message,
		ExpiresAt: time.Now().Add(5 * time.Minute),
	}
	nonceMu.Unlock()

	c.JSON(http.StatusOK, gin.H{
		"code": "0",
		"msg":  "success",
		"data": NonceResponse{
			Nonce:   nonce,
			Message: message,
		},
	})
}

// Login verifies the signature and returns API credentials
// @Summary Login with wallet signature
// @Tags Auth
// @Accept json
// @Produce json
// @Param request body LoginRequest true "Login request"
// @Success 200 {object} LoginResponse
// @Router /api/v1/auth/login [post]
func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40000",
			"msg":  "Invalid request: " + err.Error(),
			"data": nil,
		})
		return
	}

	// Validate address format
	address := strings.ToLower(req.Address)
	if !common.IsHexAddress(address) {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40001",
			"msg":  "Invalid Ethereum address",
			"data": nil,
		})
		return
	}

	// AUDIT-FIX GO-C01: 原子化 nonce 验证 + 消费
	// 旧代码: RLock→read→RUnlock→...→Lock→delete 存在 TOCTOU 竞态
	// 修复: 用 Lock 原子完成 read + validate + delete，再释放锁后做签名验证
	nonceMu.Lock()
	storedNonce, exists := nonceStore[address]
	if !exists {
		nonceMu.Unlock()
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40002",
			"msg":  "Nonce not found, please request a new one",
			"data": nil,
		})
		return
	}

	if time.Now().After(storedNonce.ExpiresAt) {
		delete(nonceStore, address)
		nonceMu.Unlock()
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40003",
			"msg":  "Nonce expired, please request a new one",
			"data": nil,
		})
		return
	}

	if storedNonce.Nonce != req.Nonce {
		nonceMu.Unlock()
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40004",
			"msg":  "Invalid nonce",
			"data": nil,
		})
		return
	}

	// P1: 使用存储的完整消息（与 GetNonce 返回给前端的完全一致）
	message := storedNonce.Message
	// 原子消费 nonce — 第二个并发请求到此时 nonce 已不存在
	delete(nonceStore, address)
	nonceMu.Unlock()

	// 签名验证（在锁外执行，避免阻塞其他地址的登录）
	recoveredAddr, err := recoverAddress(message, req.Signature)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40005",
			"msg":  "Invalid signature: " + err.Error(),
			"data": nil,
		})
		return
	}

	if strings.ToLower(recoveredAddr.Hex()) != address {
		c.JSON(http.StatusBadRequest, gin.H{
			"code": "40006",
			"msg":  "Signature does not match address",
			"data": nil,
		})
		return
	}

	// Get or create user
	// P1: API Secret 以明文存储是 HMAC 认证模型的必要条件（与 Binance/OKX 一致）。
	// 服务端需要原始 secret 来计算 HMAC-SHA256。bcrypt 不适用于此场景。
	// 未来可考虑 AES-GCM 加密存储（application-level encryption-at-rest）。
	// AUDIT-FIX GO-C02: 追踪是否新用户，仅新用户返回 API Secret
	isNewUser := false
	user, err := h.userRepo.GetByAddress(req.Address)
	if err == gorm.ErrRecordNotFound {
		// Create new user with API credentials
		isNewUser = true
		apiKey := generateAPIKey()
		apiSecret := generateAPISecret()

		user = &model.User{
			Address:   req.Address,
			APIKey:    apiKey,
			APISecret: apiSecret,
		}

		if err := h.userRepo.Create(user); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"code": "50000",
				"msg":  "Failed to create user",
				"data": nil,
			})
			return
		}
	} else if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code": "50000",
			"msg":  "Database error",
			"data": nil,
		})
		return
	} else {
		// AUDIT-FIX M-13: Reuse existing API key/secret if present (don't invalidate active sessions)
		// Only regenerate if they are empty (e.g., migrated user with no API credentials)
		if user.APIKey == "" || user.APISecret == "" {
			user.APIKey = generateAPIKey()
			user.APISecret = generateAPISecret()
		}

		if err := h.userRepo.Update(user); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"code": "50000",
				"msg":  "Failed to update user",
				"data": nil,
			})
			return
		}
	}

	// Generate JWT tokens
	accessToken, refreshToken, err := h.jwtManager.GenerateTokenPair(user.Address, user.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code": "50001",
			"msg":  "Failed to generate JWT tokens",
			"data": nil,
		})
		return
	}

	// Return API credentials and JWT tokens
	// AUDIT-FIX GO-C02: 仅新用户首次登录返回 API Secret（HMAC 模型需用户自行保存）
	// 已有用户重复登录不再泄露 secret
	responseSecret := ""
	if isNewUser {
		responseSecret = user.APISecret
	}
	c.JSON(http.StatusOK, gin.H{
		"code": "0",
		"msg":  "success",
		"data": LoginResponse{
			APIKey:       user.APIKey,
			APISecret:    responseSecret,
			AccessToken:  accessToken,
			RefreshToken: refreshToken,
			Address:      user.Address,
			ExpiresAt:    time.Now().Add(30 * 24 * time.Hour).Unix(), // 30 days
		},
	})
}

// generateNonce generates a random nonce
func generateNonce() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

// generateAPIKey generates a random API key
func generateAPIKey() string {
	bytes := make([]byte, 32)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

// generateAPISecret generates a random API secret
func generateAPISecret() string {
	bytes := make([]byte, 64)
	rand.Read(bytes)
	return hex.EncodeToString(bytes)
}

// recoverAddress recovers the address from a signed message
func recoverAddress(message, signatureHex string) (common.Address, error) {
	// Decode signature
	signature, err := hexutil.Decode(signatureHex)
	if err != nil {
		return common.Address{}, fmt.Errorf("invalid signature format: %w", err)
	}

	if len(signature) != 65 {
		return common.Address{}, fmt.Errorf("invalid signature length: %d", len(signature))
	}

	// Adjust v value for Ethereum personal sign
	if signature[64] >= 27 {
		signature[64] -= 27
	}

	// Hash the message with Ethereum prefix
	hash := accounts.TextHash([]byte(message))

	// Recover public key
	pubKey, err := crypto.SigToPub(hash, signature)
	if err != nil {
		return common.Address{}, fmt.Errorf("failed to recover public key: %w", err)
	}

	// Get address from public key
	address := crypto.PubkeyToAddress(*pubKey)
	return address, nil
}
