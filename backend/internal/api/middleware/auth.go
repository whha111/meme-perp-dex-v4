package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/memeperp/backend/internal/model"
	"github.com/memeperp/backend/internal/pkg/errors"
)

const (
	HeaderAPIKey    = "X-MBX-APIKEY"
	HeaderSignature = "X-MBX-SIGNATURE"
	HeaderTimestamp = "X-MBX-TIMESTAMP"

	// Context keys
	CtxKeyUserID  = "userID"
	CtxKeyUser    = "user"
	CtxKeyAddress = "address"

	// Timestamp tolerance (5 minutes)
	TimestampTolerance = 5 * 60 * 1000 // milliseconds
)

// AuthMiddleware validates API key and signature for private endpoints
func AuthMiddleware(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		apiKey := c.GetHeader(HeaderAPIKey)
		signature := c.GetHeader(HeaderSignature)
		timestampStr := c.GetHeader(HeaderTimestamp)

		// Check required headers
		if apiKey == "" {
			respondError(c, errors.New(errors.CodeInvalidAPIKey))
			c.Abort()
			return
		}

		if signature == "" {
			respondError(c, errors.New(errors.CodeSignatureInvalid))
			c.Abort()
			return
		}

		if timestampStr == "" {
			respondError(c, errors.New(errors.CodeTimestampInvalid))
			c.Abort()
			return
		}

		// Validate timestamp
		timestamp, err := strconv.ParseInt(timestampStr, 10, 64)
		if err != nil {
			respondError(c, errors.New(errors.CodeTimestampInvalid))
			c.Abort()
			return
		}

		now := time.Now().UnixMilli()
		if abs(now-timestamp) > TimestampTolerance {
			respondError(c, errors.Newf(errors.CodeTimestampInvalid, "timestamp expired"))
			c.Abort()
			return
		}

		// Find user by API key
		var user model.User
		if err := db.Where("api_key = ?", apiKey).First(&user).Error; err != nil {
			if err == gorm.ErrRecordNotFound {
				respondError(c, errors.New(errors.CodeInvalidAPIKey))
			} else {
				respondError(c, errors.Wrap(errors.CodeSystemError, err))
			}
			c.Abort()
			return
		}

		// Verify signature
		if !verifySignature(c, user.APISecret, signature, timestampStr) {
			respondError(c, errors.New(errors.CodeSignatureInvalid))
			c.Abort()
			return
		}

		// Set user info in context
		c.Set(CtxKeyUserID, user.ID)
		c.Set(CtxKeyUser, &user)
		c.Set(CtxKeyAddress, user.Address)

		c.Next()
	}
}

// OptionalAuthMiddleware tries to authenticate but doesn't fail if no credentials
func OptionalAuthMiddleware(db *gorm.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		apiKey := c.GetHeader(HeaderAPIKey)

		if apiKey == "" {
			c.Next()
			return
		}

		// If API key provided, validate fully
		AuthMiddleware(db)(c)
	}
}

// verifySignature verifies the HMAC-SHA256 signature
func verifySignature(c *gin.Context, secret, signature, timestamp string) bool {
	// Read body — P1: check err to prevent empty body bypassing signature
	var body []byte
	if c.Request.Body != nil {
		var err error
		body, err = io.ReadAll(c.Request.Body)
		if err != nil {
			return false // body read failed → reject
		}
		// Restore body for later use
		c.Request.Body = io.NopCloser(strings.NewReader(string(body)))
	}

	// Build message: timestamp + method + path + body
	method := c.Request.Method
	path := c.Request.URL.Path
	if c.Request.URL.RawQuery != "" {
		path += "?" + c.Request.URL.RawQuery
	}

	message := timestamp + method + path + string(body)

	// Calculate HMAC-SHA256
	h := hmac.New(sha256.New, []byte(secret))
	h.Write([]byte(message))
	expectedSignature := base64.StdEncoding.EncodeToString(h.Sum(nil))

	return hmac.Equal([]byte(signature), []byte(expectedSignature))
}

func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

func respondError(c *gin.Context, err *errors.AppError) {
	c.JSON(err.HTTPStatus(), struct {
		Code int         `json:"code"`
		Msg  string      `json:"msg"`
		Data interface{} `json:"data"`
	}{
		Code: err.Code,
		Msg:  err.Message,
		Data: nil,
	})
}

// GetUserID gets user ID from context
func GetUserID(c *gin.Context) (int64, bool) {
	userID, exists := c.Get(CtxKeyUserID)
	if !exists {
		return 0, false
	}
	return userID.(int64), true
}

// GetUser gets user from context
func GetUser(c *gin.Context) (*model.User, bool) {
	user, exists := c.Get(CtxKeyUser)
	if !exists {
		return nil, false
	}
	return user.(*model.User), true
}

// GetAddress gets user address from context
func GetAddress(c *gin.Context) (string, bool) {
	address, exists := c.Get(CtxKeyAddress)
	if !exists {
		return "", false
	}
	return address.(string), true
}
