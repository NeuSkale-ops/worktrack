package main

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type rateEntry struct {
	count int
	until time.Time
}
type loginLimiter struct {
	mu      sync.Mutex
	entries map[string]rateEntry
}

func (l *loginLimiter) allow(key string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.entries == nil {
		l.entries = make(map[string]rateEntry)
	}
	if len(l.entries) > 10000 {
		for k, v := range l.entries {
			if now.After(v.until) {
				delete(l.entries, k)
			}
		}
		if len(l.entries) > 10000 {
			return false
		}
	}
	v := l.entries[key]
	if now.After(v.until) {
		v = rateEntry{until: now.Add(time.Minute)}
	}
	v.count++
	l.entries[key] = v
	return v.count <= max
}
func (a *app) allowLogin(w http.ResponseWriter, r *http.Request, email string) bool {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	// Do not trust attacker-controlled forwarding headers. Reverse proxies share
	// the peer-IP bucket, while each account has its own stricter bucket.
	if !a.limiter.allow("ip:"+host, 120) || !a.limiter.allow("email:"+strings.ToLower(strings.TrimSpace(email)), 10) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many login attempts, retry in one minute")
		return false
	}
	return true
}
