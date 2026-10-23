package main

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"
)

type screenshotLocation struct {
	PositionSource *string    `json:"position_source,omitempty"`
	IsRemoteSource *bool      `json:"is_remote_source,omitempty"`
	Status         string     `json:"status"`
	CapturedAt     time.Time  `json:"captured_at"`
	Latitude       *float64   `json:"latitude,omitempty"`
	Longitude      *float64   `json:"longitude,omitempty"`
	Accuracy       *float64   `json:"accuracy_m,omitempty"`
	ObservedAt     *time.Time `json:"observed_at,omitempty"`
}
type applicationUsage struct {
	App          string `json:"app"`
	Milliseconds int    `json:"milliseconds"`
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func (b block) validateMonitoring() error {
	if len(b.Applications) > 32 {
		return fmt.Errorf("too many applications")
	}
	seen := map[string]bool{}
	total := 0
	for _, app := range b.Applications {
		if app.App == "" || len(app.App) > 256 || strings.TrimSpace(app.App) != app.App || strings.ContainsAny(app.App, "/\\:") || strings.ContainsFunc(app.App, unicode.IsControl) || seen[app.App] || app.Milliseconds < 1 || app.Milliseconds > 600000 {
			return fmt.Errorf("invalid application usage")
		}
		seen[app.App] = true
		total += app.Milliseconds
	}
	if total > int(b.End.Sub(b.Start).Milliseconds()) {
		return fmt.Errorf("application usage exceeds block duration")
	}
	l := b.Location
	if l == nil {
		return nil
	}
	l.CapturedAt = l.CapturedAt.UTC()
	if b.Screenshot == "" || l.CapturedAt.Before(b.End.Add(-5*time.Second)) || l.CapturedAt.After(b.End.Add(5*time.Second)) {
		return fmt.Errorf("location must belong to screenshot capture")
	}
	if l.Status != "available" {
		if (l.Status != "disabled" && l.Status != "unavailable") || l.Latitude != nil || l.Longitude != nil || l.Accuracy != nil || l.ObservedAt != nil || l.PositionSource != nil || l.IsRemoteSource != nil {
			return fmt.Errorf("invalid location status or fields")
		}
		return nil
	}
	if l.PositionSource != nil {
		switch *l.PositionSource {
		case "cellular", "satellite", "wifi", "ip_address", "default", "obfuscated", "unknown":
		default:
			return fmt.Errorf("invalid location position source")
		}
	}
	if l.Latitude == nil || l.Longitude == nil || l.Accuracy == nil || l.ObservedAt == nil {
		return fmt.Errorf("incomplete location")
	}
	*l.ObservedAt = l.ObservedAt.UTC()
	if !finite(*l.Latitude) || math.Abs(*l.Latitude) > 90 || !finite(*l.Longitude) || math.Abs(*l.Longitude) > 180 || !finite(*l.Accuracy) || *l.Accuracy <= 0 || *l.Accuracy > 20000000 || l.ObservedAt.Before(l.CapturedAt.Add(-2*time.Second)) || l.ObservedAt.After(l.CapturedAt.Add(10*time.Second)) {
		return fmt.Errorf("invalid or stale location")
	}
	return nil
}
