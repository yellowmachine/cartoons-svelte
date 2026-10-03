// Package auth implements bearer-token authentication.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

// Middleware rejects requests without "Authorization: Bearer <token>",
// except those for which public returns true. Both sides are hashed before
// the constant-time compare so the token length doesn't leak either.
func Middleware(token string, public func(*http.Request) bool, next http.Handler) http.Handler {
	want := sha256.Sum256([]byte(token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if public(r) || valid(r.Header.Get("Authorization"), want) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("WWW-Authenticate", "Bearer")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"unauthorized"}` + "\n"))
	})
}

func valid(header string, want [32]byte) bool {
	scheme, got, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return false
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(got)))
	return subtle.ConstantTimeCompare(sum[:], want[:]) == 1
}
