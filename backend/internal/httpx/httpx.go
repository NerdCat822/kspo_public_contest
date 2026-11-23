// Package httpx 는 공공 API 호출 도우미다. 공공 API 는 간헐적으로 4xx/5xx 를 돌려주므로 한 번 다시 시도하고,
// 오류 메시지에 키가 섞여 나가지 않도록 가린다.
package httpx

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	http    *http.Client
	secrets []string
}

func New(secrets []string) *Client {
	return &Client{http: &http.Client{}, secrets: secrets}
}

// Mask 는 문자열에서 키(원문과 URL 인코딩된 형태)를 *** 로 바꾼다.
func (c *Client) Mask(s string) string {
	for _, sec := range c.secrets {
		if sec == "" {
			continue
		}
		s = strings.ReplaceAll(s, sec, "***")
		s = strings.ReplaceAll(s, url.QueryEscape(sec), "***")
	}
	return s
}

func (c *Client) Text(ctx context.Context, u string, timeout time.Duration) ([]byte, error) {
	b, err := c.once(ctx, u, timeout)
	if err == nil {
		return b, nil
	}
	select {
	case <-ctx.Done():
		return nil, err
	case <-time.After(700 * time.Millisecond):
	}
	return c.once(ctx, u, timeout)
}

func (c *Client) once(ctx context.Context, u string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("%s", c.Mask(err.Error()))
	}
	req.Header.Set("User-Agent", "gilmak-doctor/0.1")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s", c.Mask(fmt.Sprintf("%v (%s)", err, base(u))))
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, fmt.Errorf("%s", c.Mask(fmt.Sprintf("%v (%s)", err, base(u))))
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d (%s)", res.StatusCode, c.Mask(base(u)))
	}
	return body, nil
}

func (c *Client) JSON(ctx context.Context, u string, timeout time.Duration, out any) error {
	b, err := c.Text(ctx, u, timeout)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, out); err != nil {
		snippet := string(b)
		if len(snippet) > 120 {
			snippet = snippet[:120]
		}
		return fmt.Errorf("JSON 형식이 아님: %s", c.Mask(snippet))
	}
	return nil
}

// base 는 쿼리(키 포함)를 뗀 주소
func base(u string) string {
	b, _, _ := strings.Cut(u, "?")
	return b
}
