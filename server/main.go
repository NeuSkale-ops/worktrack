package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/argon2"
)

//go:embed migrations/*.sql
var migrations embed.FS

type app struct {
	db        *pgxpool.Pool
	origin    string
	dev       bool
	s3        *s3.Client
	signer    *s3.PresignClient
	bucket    string
	authSlots chan struct{}
	limiter   loginLimiter
}
type user struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}
type identity struct {
	user
	hash string
	kind string
}
type contextKey struct{}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	db, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		slog.Error("database", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	a := &app{db: db, origin: env("APP_ORIGIN", "http://localhost:5173"), dev: os.Getenv("DEV_MODE") == "true", authSlots: make(chan struct{}, 4)}
	if err = a.migrate(ctx); err != nil {
		slog.Error("migration", "error", err)
		os.Exit(1)
	}
	if err = a.bootstrap(ctx); err != nil {
		slog.Error("bootstrap", "error", err)
		os.Exit(1)
	}
	if endpoint := os.Getenv("R2_ENDPOINT"); endpoint != "" && os.Getenv("R2_BUCKET") != "" {
		cfg, e := config.LoadDefaultConfig(ctx,
			config.WithRegion(env("R2_REGION", "auto")),
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
				os.Getenv("R2_ACCESS_KEY_ID"), os.Getenv("R2_SECRET_ACCESS_KEY"), "")),
		)
		if e != nil {
			slog.Error("storage", "error", e)
			os.Exit(1)
		}
		a.s3 = s3.NewFromConfig(cfg, func(o *s3.Options) { o.BaseEndpoint = aws.String(endpoint); o.UsePathStyle = true })
		a.signer = s3.NewPresignClient(a.s3)
		a.bucket = os.Getenv("R2_BUCKET")
	}
	go a.cleanupUploads(ctx)
	go a.cleanupAgentLogs(ctx)
	srv := &http.Server{Addr: env("LISTEN_ADDR", ":8080"), Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	go func() {
		<-ctx.Done()
		c, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_ = srv.Shutdown(c)
	}()
	slog.Info("listening", "address", srv.Addr)
	if err = srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("http", "error", err)
		os.Exit(1)
	}
}
func (a *app) migrate(ctx context.Context) error {
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(74123019)"); e != nil {
		return e
	}
	sql, e := migrations.ReadFile("migrations/001_init.sql")
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, string(sql)); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (a *app) bootstrap(ctx context.Context) error {
	email, password := strings.ToLower(strings.TrimSpace(os.Getenv("BOOTSTRAP_EMAIL"))), os.Getenv("BOOTSTRAP_PASSWORD")
	if email == "" || password == "" {
		return nil
	}
	if len(password) < 12 && os.Getenv("ALLOW_WEAK_BOOTSTRAP_PASSWORD") != "true" {
		return errors.New("bootstrap password must contain at least 12 characters")
	}
	tx, e := a.db.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(74123020)"); e != nil {
		return e
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); e != nil {
		return e
	}
	if count == 0 {
		if len(password) < 12 {
			slog.Warn("initial owner password is below the recommended minimum; explicit bootstrap override enabled")
		}
		_, e = tx.Exec(ctx, "INSERT INTO users(id,email,name,role,password_hash) VALUES($1,$2,$3,'owner',$4)", uuid.NewString(), email, env("BOOTSTRAP_NAME", "Owner"), passwordHash(password))
		if e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func token() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func digest(v string) string { b := sha256.Sum256([]byte(v)); return hex.EncodeToString(b[:]) }
func passwordHash(p string) string {
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		panic(e)
	}
	key := argon2.IDKey([]byte(p), salt, 3, 64*1024, 2, 32)
	return base64.RawStdEncoding.EncodeToString(salt) + "." + base64.RawStdEncoding.EncodeToString(key)
}
func passwordOK(p, h string) bool {
	parts := strings.Split(h, ".")
	if len(parts) != 2 {
		return false
	}
	salt, e := base64.RawStdEncoding.DecodeString(parts[0])
	if e != nil || len(salt) != 16 {
		return false
	}
	want, e := base64.RawStdEncoding.DecodeString(parts[1])
	if e != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(p), salt, 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(want, got) == 1
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, status int, s string) {
	writeJSON(w, status, map[string]string{"error": s})
}
func ok(w http.ResponseWriter) { writeJSON(w, 200, map[string]bool{"ok": true}) }
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		fail(w, 400, "invalid JSON body")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		fail(w, 400, "expected one JSON value")
		return false
	}
	return true
}
func current(r *http.Request) identity { return r.Context().Value(contextKey{}).(identity) }
func (a *app) allowed(origin string) bool {
	if origin == a.origin {
		return true
	}
	if !a.dev {
		return false
	}
	u, e := url.Parse(origin)
	return e == nil && u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1") && u.User == nil && u.Path == ""
}
func (a *app) security(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !a.allowed(origin) {
				fail(w, 403, "origin denied")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.WriteHeader(204)
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") && origin == "" && r.URL.Path != "/api/auth/login" {
			fail(w, 403, "Origin required for cookie requests")
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *app) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		value, kind := "", "browser"
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			value = strings.TrimPrefix(h, "Bearer ")
			kind = "device"
		} else if c, e := r.Cookie("worktrack_session"); e == nil {
			value = c.Value
		}
		if value == "" {
			fail(w, 401, "authentication required")
			return
		}
		var i identity
		i.hash = digest(value)
		i.kind = kind
		e := a.db.QueryRow(r.Context(), "SELECT u.id::text,u.email,u.name,u.role FROM credentials c JOIN users u ON u.id=c.user_id WHERE c.token_hash=$1 AND c.kind=$2 AND c.expires_at>now()", i.hash, kind).Scan(&i.ID, &i.Email, &i.Name, &i.Role)
		if errors.Is(e, pgx.ErrNoRows) {
			fail(w, 401, "invalid or expired session")
			return
		}
		if e != nil {
			fail(w, 503, "authentication unavailable")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, i)))
	}
}
func (a *app) routes() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		if a.db != nil && a.db.Ping(r.Context()) != nil {
			fail(w, 503, "database unavailable")
			return
		}
		ok(w)
	})
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { ok(w) })
	m.HandleFunc("POST /api/auth/login", a.login)
	m.HandleFunc("POST /api/auth/accept-invite", a.acceptInvite)
	for path, h := range map[string]http.HandlerFunc{"GET /api/auth/me": func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, current(r).user) }, "POST /api/auth/logout": a.logout, "POST /api/invites": a.invite, "GET /api/team": a.team, "POST /api/agent/logs": a.ingestAgentLogs, "GET /api/agent/logs": a.agentLogs, "GET /api/sessions/current": a.openSession, "POST /api/sessions/recover": a.recoverSession, "POST /api/sessions/start": a.start, "POST /api/sessions/stop": a.stop, "POST /api/heartbeat": a.heartbeat, "POST /api/uploads/screenshot-url": a.upload, "POST /api/blocks": a.blocks, "DELETE /api/blocks/{id}/screenshot": a.deleteScreenshot, "DELETE /api/blocks/{id}": a.deleteBlock, "GET /api/timeline": a.timeline, "GET /api/reports/hours": a.hours, "GET /api/reports/hours.csv": a.hours} {
		m.HandleFunc(path, a.auth(h))
	}
	return a.security(m)
}
