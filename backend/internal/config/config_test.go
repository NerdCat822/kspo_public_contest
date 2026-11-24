package config

import "testing"

func TestWithHost(t *testing.T) {
	cases := []struct{ dsn, host, want string }{
		{"postgres://u:p@127.0.0.1:5432/db?sslmode=disable", "postgres-db", "postgres://u:p@postgres-db:5432/db?sslmode=disable"},
		{"postgres://u:p@localhost/db", "postgres-db", "postgres://u:p@postgres-db/db"},
		{"postgres://u:p@127.0.0.1:5432/db", "", "postgres://u:p@127.0.0.1:5432/db"},
		{"", "postgres-db", ""},
	}
	for _, c := range cases {
		if got := withHost(c.dsn, c.host); got != c.want {
			t.Errorf("withHost(%q, %q) = %q, want %q", c.dsn, c.host, got, c.want)
		}
	}
}
