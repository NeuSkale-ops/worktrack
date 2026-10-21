package main

import (
	"context"
	"strings"
	"testing"
)

func TestBootstrapWeakPasswordRejectedByDefault(t *testing.T) {
	t.Setenv("BOOTSTRAP_EMAIL", "fixture@example.test")
	t.Setenv("BOOTSTRAP_PASSWORD", "short")
	for _, value := range []string{"", "false", "TRUE"} {
		t.Setenv("ALLOW_WEAK_BOOTSTRAP_PASSWORD", value)
		err := (&app{}).bootstrap(context.Background())
		if err == nil || !strings.Contains(err.Error(), "at least 12") {
			t.Fatalf("override %q did not preserve default password validation", value)
		}
	}
}
