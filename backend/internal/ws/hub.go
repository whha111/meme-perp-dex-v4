package ws

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/zap"

	"github.com/memeperp/backend/internal/pkg/database"
	"github.com/memeperp/backend/internal/pkg/jwt"
)

// Message types
const (
	OpSubscribe   = "subscribe"
	OpUnsubscribe = "unsubscribe"
	OpLogin       = "login"
	OpPing        = "ping"
	OpPong        = "pong"
)

// Channel names
const (
	ChannelTickers      = "tickers"
	ChannelCandles      = "candle"
	ChannelTrades       = "trades"
	ChannelBooks        = "books"
	ChannelMarkPrice    = "mark-price"
	ChannelFundingRate  = "funding-rate"
	ChannelAccount      = "account"
	ChannelPositions    = "positions"
	ChannelOrders       = "orders"
	ChannelLiquidation  = "liquidation-warning"
)

// Message represents a WebSocket message
type Message struct {
	Op   string          `json:"op"`
	Args []SubscribeArg  `json:"args,omitempty"`
	Data json.RawMessage `json:"data,omitempty"`
}

// SubscribeArg represents subscription arguments
type SubscribeArg struct {
	Channel string `json:"channel"`
	InstID  string `json:"instId,omitempty"`
}

// LoginArgs represents login arguments
type LoginArgs struct {
	Token string `json:"token"` // JWT access token
}

// PushMessage represents a message pushed to clients
type PushMessage struct {
	Arg  SubscribeArg    `json:"arg"`
	Data json.RawMessage `json:"data"`
}

// Hub manages WebSocket connections
type Hub struct {
	clients       map[*Client]bool
	subscriptions map[string]map[*Client]bool // channel -> clients
	broadcast     chan *PushMessage
	register      chan *Client
	unregister    chan *Client
	cache         *database.Cache
	jwtManager    *jwt.Manager
	logger        *zap.Logger
	mu            sync.RWMutex
}

// NewHub creates a new Hub
func NewHub(cache *database.Cache, jwtManager *jwt.Manager, logger *zap.Logger) *Hub {
	return &Hub{
		clients:       make(map[*Client]bool),
		subscriptions: make(map[string]map[*Client]bool),
		broadcast:     make(chan *PushMessage, 256),
		register:      make(chan *Client),
		unregister:    make(chan *Client),
		cache:         cache,
		jwtManager:    jwtManager,
		logger:        logger,
	}
}

// Run starts the hub's main loop
func (h *Hub) Run(ctx context.Context) {
	h.logger.Info("WebSocket hub started")

	for {
		select {
		case <-ctx.Done():
			h.logger.Info("WebSocket hub shutting down")
			return

		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()
			h.logger.Debug("Client connected", zap.String("addr", client.conn.RemoteAddr().String()))

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				// Remove from all subscriptions
				for channel := range h.subscriptions {
					delete(h.subscriptions[channel], client)
				}
				close(client.send)
			}
			h.mu.Unlock()
			h.logger.Debug("Client disconnected", zap.String("addr", client.conn.RemoteAddr().String()))

		case msg := <-h.broadcast:
			h.broadcastToSubscribers(msg)
		}
	}
}

func (h *Hub) broadcastToSubscribers(msg *PushMessage) {
	channelKey := buildChannelKey(msg.Arg.Channel, msg.Arg.InstID)

	h.mu.RLock()
	subscribers, ok := h.subscriptions[channelKey]
	h.mu.RUnlock()

	if !ok {
		return
	}

	data, err := json.Marshal(msg)
	if err != nil {
		h.logger.Error("Failed to marshal message", zap.Error(err))
		return
	}

	for client := range subscribers {
		select {
		case client.send <- data:
		default:
			// Client buffer full, disconnect
			h.unregister <- client
		}
	}
}

// Subscribe adds a client to a channel
func (h *Hub) Subscribe(client *Client, channel, instID string) {
	channelKey := buildChannelKey(channel, instID)

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.subscriptions[channelKey] == nil {
		h.subscriptions[channelKey] = make(map[*Client]bool)
	}
	h.subscriptions[channelKey][client] = true

	h.logger.Debug("Client subscribed", zap.String("channel", channelKey))
}

// Unsubscribe removes a client from a channel
func (h *Hub) Unsubscribe(client *Client, channel, instID string) {
	channelKey := buildChannelKey(channel, instID)

	h.mu.Lock()
	defer h.mu.Unlock()

	if subs, ok := h.subscriptions[channelKey]; ok {
		delete(subs, client)
	}

	h.logger.Debug("Client unsubscribed", zap.String("channel", channelKey))
}

// Broadcast sends a message to all subscribers of a channel
func (h *Hub) Broadcast(channel, instID string, data interface{}) {
	jsonData, err := json.Marshal(data)
	if err != nil {
		h.logger.Error("Failed to marshal broadcast data", zap.Error(err))
		return
	}

	h.broadcast <- &PushMessage{
		Arg: SubscribeArg{
			Channel: channel,
			InstID:  instID,
		},
		Data: jsonData,
	}
}

func buildChannelKey(channel, instID string) string {
	if instID != "" {
		return channel + ":" + instID
	}
	return channel
}

// Register adds a client to the hub
func (h *Hub) Register(client *Client) {
	h.register <- client
}

// Client represents a WebSocket client
type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	send    chan []byte
	userID  int64
	address string
	isAuth  bool
	mu      sync.RWMutex
}

// NewClient creates a new client
func NewClient(hub *Hub, conn *websocket.Conn) *Client {
	return &Client{
		hub:  hub,
		conn: conn,
		send: make(chan []byte, 256),
	}
}

// ReadPump reads messages from the WebSocket connection
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(512 * 1024) // 512KB
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.hub.logger.Error("WebSocket read error", zap.Error(err))
			}
			break
		}

		c.handleMessage(message)
	}
}

// WritePump writes messages to the WebSocket connection
func (c *Client) WritePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleMessage(message []byte) {
	// Handle ping/pong as simple strings
	if string(message) == "ping" {
		c.send <- []byte("pong")
		return
	}

	var msg Message
	if err := json.Unmarshal(message, &msg); err != nil {
		c.sendError("Invalid JSON format")
		return
	}

	switch msg.Op {
	case OpSubscribe:
		// P0-1: 预检所有 channel — 如果任何 private channel 未认证，拒绝整个请求
		// 防止混合 ["trades","account"] 绕过 auth
		for _, arg := range msg.Args {
			if isPrivateChannel(arg.Channel) {
				c.mu.RLock()
				isAuth := c.isAuth
				c.mu.RUnlock()

				if !isAuth {
					c.sendError("Authentication required for private channel: " + arg.Channel + ". Entire subscribe request rejected.")
					return
				}
			}
		}
		// 全部通过检查后，才执行订阅
		for _, arg := range msg.Args {
			c.hub.Subscribe(c, arg.Channel, arg.InstID)
		}
		c.sendResponse(msg.Op, msg.Args)

	case OpUnsubscribe:
		for _, arg := range msg.Args {
			c.hub.Unsubscribe(c, arg.Channel, arg.InstID)
		}
		c.sendResponse(msg.Op, msg.Args)

	case OpLogin:
		// Handle authentication for private channels
		c.handleLogin(msg)

	case OpPing:
		c.send <- []byte(`"pong"`)

	default:
		c.sendError("Unknown operation")
	}
}

// isPrivateChannel checks if a channel requires authentication
func isPrivateChannel(channel string) bool {
	privateChannels := []string{
		ChannelAccount,
		ChannelPositions,
		ChannelOrders,
		ChannelLiquidation,
	}

	for _, pc := range privateChannels {
		if channel == pc {
			return true
		}
	}
	return false
}

func (c *Client) handleLogin(msg Message) {
	// Parse login arguments
	var loginArgs LoginArgs
	if err := json.Unmarshal(msg.Data, &loginArgs); err != nil {
		c.sendError("Invalid login data format")
		return
	}

	if loginArgs.Token == "" {
		c.sendError("Token is required for authentication")
		return
	}

	// Validate JWT token
	claims, err := c.hub.jwtManager.ValidateToken(loginArgs.Token)
	if err != nil {
		c.hub.logger.Debug("JWT validation failed", zap.Error(err))
		c.sendError("Invalid or expired token")
		return
	}

	// Set user info
	c.mu.Lock()
	c.isAuth = true
	c.userID = claims.UserID
	c.address = claims.Address
	c.mu.Unlock()

	c.hub.logger.Info("Client authenticated via WebSocket",
		zap.Int64("userID", claims.UserID),
		zap.String("address", claims.Address))

	// Send success response
	c.sendResponse("login", nil)
}

func (c *Client) sendResponse(event string, args []SubscribeArg) {
	resp := map[string]interface{}{
		"event": event,
		"args":  args,
	}
	data, _ := json.Marshal(resp)
	c.send <- data
}

func (c *Client) sendError(message string) {
	resp := map[string]interface{}{
		"event": "error",
		"msg":   message,
	}
	data, _ := json.Marshal(resp)
	c.send <- data
}
