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

// parseProxies reads comma-separated CIDRs or IPs, e.g. TRUSTED_PROXIES=172.16.0.0/12.
func parseProxies(v string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s == "" {
			continue
		}
		if !strings.Contains(s, "/") {
			if ip := net.ParseIP(s); ip != nil && ip.To4() != nil {
				s += "/32"
			} else {
				s += "/128"
			}
		}
		_, n, e := net.ParseCIDR(s)
		if e != nil {
			return nil, e
		}
		out = append(out, n)
	}
	return out, nil
}
func (a *app) trusted(ip net.IP) bool {
	for _, n := range a.proxies {
		if ip != nil && n.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP walks X-Forwarded-For right to left only while hops are trusted
// proxies, so a client cannot spoof its address by prepending entries.
func (a *app) clientIP(r *http.Request) string {
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		host = r.RemoteAddr
	}
	if !a.trusted(net.ParseIP(host)) {
		return host
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	for i := len(hops) - 1; i >= 0; i-- {
		hop := strings.TrimSpace(hops[i])
		ip := net.ParseIP(hop)
		if ip == nil {
			return host
		}
		host = hop
		if !a.trusted(ip) {
			break
		}
	}
	return host
}
func (a *app) allowLogin(w http.ResponseWriter, r *http.Request, email string) bool {
	host := a.clientIP(r)
	// Forwarded headers count only from TRUSTED_PROXIES peers. Without that
	// setting, clients behind a proxy share its bucket. Each account also has
	// its own stricter bucket.
	if !a.limiter.allow("ip:"+host, 120) || !a.limiter.allow("email:"+strings.ToLower(strings.TrimSpace(email)), 10) {
		w.Header().Set("Retry-After", "60")
		fail(w, 429, "too many login attempts, retry in one minute")
		return false
	}
	return true
}
