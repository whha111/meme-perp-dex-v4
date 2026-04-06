package config

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Server         ServerConfig         `mapstructure:"server"`
	Database       DatabaseConfig       `mapstructure:"database"`
	Redis          RedisConfig          `mapstructure:"redis"`
	Blockchain     BlockchainConfig     `mapstructure:"blockchain"`
	MatchingEngine MatchingEngineConfig `mapstructure:"matching_engine"`
	JWT            JWTConfig            `mapstructure:"jwt"`
	RateLimit      RateLimitConfig      `mapstructure:"rate_limit"`
	Security       SecurityConfig       `mapstructure:"security"`
	Log            LogConfig            `mapstructure:"log"`
}

type SecurityConfig struct {
	AllowedOrigins []string `mapstructure:"allowed_origins"`
	TrustedProxies []string `mapstructure:"trusted_proxies"`
}

type ServerConfig struct {
	Addr         string        `mapstructure:"addr"`
	Mode         string        `mapstructure:"mode"` // debug, release
	ReadTimeout  time.Duration `mapstructure:"read_timeout"`
	WriteTimeout time.Duration `mapstructure:"write_timeout"`
}

type DatabaseConfig struct {
	Host         string        `mapstructure:"host"`
	Port         int           `mapstructure:"port"`
	User         string        `mapstructure:"user"`
	Password     string        `mapstructure:"password"`
	DBName       string        `mapstructure:"dbname"`
	SSLMode      string        `mapstructure:"sslmode"`
	MaxIdleConns int           `mapstructure:"max_idle_conns"`
	MaxOpenConns int           `mapstructure:"max_open_conns"`
	MaxLifetime  time.Duration `mapstructure:"max_lifetime"`
}

func (d DatabaseConfig) DSN() string {
	return fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
		d.Host, d.Port, d.User, d.Password, d.DBName, d.SSLMode)
}

type RedisConfig struct {
	Addr     string `mapstructure:"addr"`
	Password string `mapstructure:"password"`
	DB       int    `mapstructure:"db"`
	PoolSize int    `mapstructure:"pool_size"`
}

type BlockchainConfig struct {
	RPCURL           string `mapstructure:"rpc_url"`
	ChainID          int64  `mapstructure:"chain_id"`
	RouterAddress    string `mapstructure:"router_address"`
	VaultAddress     string `mapstructure:"vault_address"`
	AMMAddress       string `mapstructure:"amm_address"`
	PositionAddress  string `mapstructure:"position_address"`
	SettlementAddr   string `mapstructure:"settlement_address"` // Settlement contract for P2P trading
	LiquidationAddr  string `mapstructure:"liquidation_address"`
	FundingRateAddr  string `mapstructure:"funding_rate_address"`
	LendingPoolAddr  string `mapstructure:"lending_pool_address"`
	PriceFeedAddr    string `mapstructure:"price_feed_address"`
	PrivateKey       string `mapstructure:"private_key"`
	StartBlock       uint64 `mapstructure:"start_block"`
	ConfirmBlocks    uint64 `mapstructure:"confirm_blocks"`
	PollInterval     time.Duration `mapstructure:"poll_interval"`
}

type MatchingEngineConfig struct {
	URL string `mapstructure:"url"` // Matching Engine HTTP API URL (e.g., http://localhost:8081)
}

type JWTConfig struct {
	Secret     string        `mapstructure:"secret"`
	Expiration time.Duration `mapstructure:"expiration"`
}

type RateLimitConfig struct {
	PublicLimit  int `mapstructure:"public_limit"`  // per minute
	PrivateLimit int `mapstructure:"private_limit"` // per minute
	OrderLimit   int `mapstructure:"order_limit"`   // per minute
}

type LogConfig struct {
	Level  string `mapstructure:"level"` // debug, info, warn, error
	Format string `mapstructure:"format"` // json, console
	Output string `mapstructure:"output"` // stdout, file path
}

func Load() (*Config, error) {
	// Set defaults first (only non-sensitive defaults)
	setDefaults()

	// 1. Read base config file
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath("./configs")
	viper.AddConfigPath(".")
	viper.AddConfigPath("/etc/memeperp/")

	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("failed to read base config: %w", err)
		}
	}

	// 2. Override with environment-specific config (e.g., config.local.yaml, config.production.yaml)
	env := os.Getenv("APP_ENV")
	if env == "" {
		env = "local" // Default to local development
	}

	envConfigName := fmt.Sprintf("config.%s", env)
	viper.SetConfigName(envConfigName)

	if err := viper.MergeInConfig(); err != nil {
		// Environment-specific config is optional
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("failed to merge env config: %w", err)
		}
	}

	// 3. Override with environment variables (highest priority)
	viper.SetEnvPrefix("MEMEPERP")
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	viper.AutomaticEnv()

	// AUDIT-FIX H-13: Expand ${VAR} and ${VAR:-default} shell syntax in all string values
	// Viper does NOT expand these natively — it loads them as literal strings
	expandShellVarsInViper()

	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}

	// 4. Validate required fields
	if err := validateConfig(&cfg); err != nil {
		return nil, fmt.Errorf("config validation failed: %w", err)
	}

	return &cfg, nil
}

// AUDIT-FIX H-13: Expand ${VAR} and ${VAR:-default} shell-style syntax in Viper string values.
// Viper's AutomaticEnv only maps flat env keys to config keys — it does NOT expand shell syntax
// embedded in YAML values like: password: "${MEMEPERP_REDIS_PASSWORD}"
var shellVarRe = regexp.MustCompile(`\$\{([^}]+)\}`)

func expandShellVarsInViper() {
	for _, key := range viper.AllKeys() {
		val := viper.GetString(key)
		if !strings.Contains(val, "${") {
			continue
		}
		expanded := shellVarRe.ReplaceAllStringFunc(val, func(match string) string {
			// Extract VAR or VAR:-default from ${...}
			inner := match[2 : len(match)-1] // strip ${ and }
			if idx := strings.Index(inner, ":-"); idx >= 0 {
				// ${VAR:-default} syntax
				envName := inner[:idx]
				defaultVal := inner[idx+2:]
				if envVal := os.Getenv(envName); envVal != "" {
					return envVal
				}
				return defaultVal
			}
			if idx := strings.Index(inner, ":?"); idx >= 0 {
				// ${VAR:?error} syntax — required variable
				envName := inner[:idx]
				if envVal := os.Getenv(envName); envVal != "" {
					return envVal
				}
				return "" // will be caught by validation later
			}
			// Plain ${VAR} syntax
			return os.Getenv(inner)
		})
		if expanded != val {
			viper.Set(key, expanded)
		}
	}
}

func setDefaults() {
	// Server
	viper.SetDefault("server.addr", ":8080")
	viper.SetDefault("server.mode", "debug")
	viper.SetDefault("server.read_timeout", 10*time.Second)
	viper.SetDefault("server.write_timeout", 10*time.Second)

	// Database (non-sensitive defaults only)
	viper.SetDefault("database.host", "localhost")
	viper.SetDefault("database.port", 5432)
	viper.SetDefault("database.user", "postgres")
	// REMOVED: database.password - must be set explicitly
	viper.SetDefault("database.dbname", "memeperp")
	viper.SetDefault("database.sslmode", "disable")
	viper.SetDefault("database.max_idle_conns", 10)
	viper.SetDefault("database.max_open_conns", 100)
	viper.SetDefault("database.max_lifetime", time.Hour)

	// Redis (non-sensitive defaults only)
	viper.SetDefault("redis.addr", "localhost:6379")
	// REMOVED: redis.password - must be set explicitly if needed
	viper.SetDefault("redis.db", 0)
	viper.SetDefault("redis.pool_size", 10)

	// Blockchain
	viper.SetDefault("blockchain.chain_id", 31337) // Anvil local testnet
	viper.SetDefault("blockchain.confirm_blocks", 3)
	viper.SetDefault("blockchain.poll_interval", 3*time.Second)

	// Matching Engine (TypeScript service on port 8081)
	viper.SetDefault("matching_engine.url", "http://localhost:8081")

	// JWT
	// REMOVED: jwt.secret - must be set explicitly
	viper.SetDefault("jwt.expiration", 24*time.Hour)

	// Rate Limit
	viper.SetDefault("rate_limit.public_limit", 1200)
	viper.SetDefault("rate_limit.private_limit", 600)
	viper.SetDefault("rate_limit.order_limit", 300)

	// Security
	viper.SetDefault("security.allowed_origins", []string{"http://localhost:3000"})
	viper.SetDefault("security.trusted_proxies", []string{})

	// Log
	viper.SetDefault("log.level", "info")
	viper.SetDefault("log.format", "json")
	viper.SetDefault("log.output", "stdout")
}

// validateConfig validates that all required configuration fields are set
func validateConfig(cfg *Config) error {
	var errors []string

	// JWT secret is always required
	if cfg.JWT.Secret == "" {
		errors = append(errors, "jwt.secret is required (set MEMEPERP_JWT_SECRET environment variable)")
	}
	if len(cfg.JWT.Secret) < 32 {
		errors = append(errors, "jwt.secret must be at least 32 characters for security")
	}

	// In production mode, require secure configurations
	if cfg.Server.Mode == "release" || cfg.Server.Mode == "production" {
		if cfg.Database.Password == "" || cfg.Database.Password == "postgres" {
			errors = append(errors, "database.password must be set securely in production (set MEMEPERP_DATABASE_PASSWORD)")
		}

		// Allow sslmode=disable for Docker-internal PostgreSQL (network-isolated)
		// Only warn if connecting to an external database without SSL
		if cfg.Database.SSLMode == "disable" && cfg.Database.Host != "postgres" && cfg.Database.Host != "localhost" && cfg.Database.Host != "127.0.0.1" {
			errors = append(errors, "database.sslmode should be 'require' or 'verify-full' for external databases in production")
		}

		if cfg.Blockchain.PrivateKey == "" {
			errors = append(errors, "blockchain.private_key is required in production (set MEMEPERP_BLOCKCHAIN_PRIVATE_KEY)")
		}

		if len(cfg.Security.AllowedOrigins) == 0 || (len(cfg.Security.AllowedOrigins) == 1 && cfg.Security.AllowedOrigins[0] == "*") {
			errors = append(errors, "security.allowed_origins must be explicitly configured in production (not '*')")
		}

		// P2-59: Reject localhost defaults in production
		for _, origin := range cfg.Security.AllowedOrigins {
			if strings.Contains(origin, "localhost") || strings.Contains(origin, "127.0.0.1") {
				errors = append(errors, "security.allowed_origins must not contain localhost in production")
				break
			}
		}

		if strings.Contains(cfg.MatchingEngine.URL, "localhost") || strings.Contains(cfg.MatchingEngine.URL, "127.0.0.1") {
			errors = append(errors, "matching_engine.url must not be localhost in production")
		}
	}

	// Validate blockchain configuration
	if cfg.Blockchain.RPCURL == "" {
		errors = append(errors, "blockchain.rpc_url is required (set MEMEPERP_BLOCKCHAIN_RPC_URL)")
	}

	if cfg.Blockchain.ChainID == 0 {
		errors = append(errors, "blockchain.chain_id is required")
	}

	// Settlement address (position_address) is critical
	if cfg.Blockchain.PositionAddress == "" {
		errors = append(errors, "blockchain.position_address (Settlement contract) is required")
	}

	if len(errors) > 0 {
		return fmt.Errorf("configuration validation failed:\n  - %s", strings.Join(errors, "\n  - "))
	}

	return nil
}
