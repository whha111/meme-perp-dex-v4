package response

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/memeperp/backend/internal/pkg/errors"
)

// Response represents the standard API response
type Response struct {
	Code int         `json:"code"`
	Msg  string      `json:"msg"`
	Data interface{} `json:"data"`
}

// PagedResponse represents a paginated response
type PagedResponse struct {
	List     interface{} `json:"list"`
	Total    int64       `json:"total"`
	Page     int         `json:"page"`
	PageSize int         `json:"pageSize"`
}

// Success returns a successful response
func Success(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, Response{
		Code: errors.CodeSuccess,
		Msg:  "success",
		Data: data,
	})
}

// SuccessPaged returns a paginated successful response
func SuccessPaged(c *gin.Context, list interface{}, total int64, page, pageSize int) {
	c.JSON(http.StatusOK, Response{
		Code: errors.CodeSuccess,
		Msg:  "success",
		Data: PagedResponse{
			List:     list,
			Total:    total,
			Page:     page,
			PageSize: pageSize,
		},
	})
}

// Error returns an error response
func Error(c *gin.Context, err error) {
	if appErr, ok := err.(*errors.AppError); ok {
		c.JSON(appErr.HTTPStatus(), Response{
			Code: appErr.Code,
			Msg:  appErr.Message,
			Data: nil,
		})
		return
	}

	c.JSON(http.StatusInternalServerError, Response{
		Code: errors.CodeSystemError,
		Msg:  err.Error(),
		Data: nil,
	})
}

// ErrorWithCode returns an error response with specific code
func ErrorWithCode(c *gin.Context, code int, msg string) {
	status := http.StatusBadRequest
	if code >= 50100 && code < 50200 {
		status = http.StatusUnauthorized
	} else if code >= 53000 && code < 54000 {
		status = http.StatusForbidden
	}

	c.JSON(status, Response{
		Code: code,
		Msg:  msg,
		Data: nil,
	})
}

// OrderResponse represents order operation result
type OrderResponse struct {
	OrdID   string `json:"ordId"`
	ClOrdID string `json:"clOrdId,omitempty"`
	SCode   string `json:"sCode"`
	SMsg    string `json:"sMsg,omitempty"`
}

// SuccessOrder returns a successful order response
func SuccessOrder(c *gin.Context, ordID, clOrdID string) {
	Success(c, OrderResponse{
		OrdID:   ordID,
		ClOrdID: clOrdID,
		SCode:   "0",
		SMsg:    "",
	})
}

// ErrorOrder returns an order error response with proper HTTP status
func ErrorOrder(c *gin.Context, code int, msg string) {
	httpStatus := http.StatusBadRequest
	if code >= 50100 && code < 50200 {
		httpStatus = http.StatusUnauthorized
	} else if code >= 50000 && code < 51000 {
		httpStatus = http.StatusInternalServerError
	}
	c.JSON(httpStatus, Response{
		Code: code,
		Msg:  msg,
		Data: OrderResponse{
			SCode: itoa(code),
			SMsg:  msg,
		},
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	if n < 0 {
		return "-" + uitoa(uint(-n))
	}
	return uitoa(uint(n))
}

func uitoa(n uint) string {
	var buf [20]byte
	i := len(buf)
	for n >= 10 {
		i--
		buf[i] = byte(n%10 + '0')
		n /= 10
	}
	i--
	buf[i] = byte(n + '0')
	return string(buf[i:])
}
