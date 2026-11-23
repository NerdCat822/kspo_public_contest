// Package ml 은 예측을 Python AI 서비스(ai/, POST /ml/forecast)에 맡긴다.
// AI 서비스가 꺼져 있거나 응답이 늦으면 Go 에 내장된 같은 모델(internal/model)로 대신 계산해,
// 화면은 AI 서비스 없이도 동작한다. 어느 쪽이 계산했는지는 ModelMeta.Source 에 남긴다.
package ml

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/model"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

const timeout = 3 * time.Second

type DayInput struct {
	Date    string
	DayType types.DayType
	Shows   []types.Show
}

type DayForecast struct {
	Bins []types.ForecastBin `json:"bins"`
	Peak types.Peak          `json:"peak"`
}

type Result struct {
	Model      types.ModelMeta
	Thresholds types.Thresholds
	Days       map[string]DayForecast
}

type Client struct {
	base string
	http *http.Client
}

func New(baseURL string) *Client {
	return &Client{base: baseURL, http: &http.Client{Timeout: timeout}}
}

type showIn struct {
	Start string `json:"start"`
	Seats int    `json:"seats"`
	Major bool   `json:"major"`
}

type dayIn struct {
	Date    string        `json:"date"`
	DayType types.DayType `json:"dayType"`
	Shows   []showIn      `json:"shows"`
}

type response struct {
	Model      types.ModelMeta  `json:"model"`
	Thresholds types.Thresholds `json:"thresholds"`
	Forecasts  []struct {
		Date string `json:"date"`
		DayForecast
	} `json:"forecasts"`
}

// Forecast 는 여러 날을 한 번에 예측한다. AI 서비스가 실패하면 내장 모델 결과를 돌려준다.
func (c *Client) Forecast(ctx context.Context, days []DayInput) Result {
	if c != nil && c.base != "" {
		res, err := c.remote(ctx, days)
		if err == nil {
			return res
		}
		log.Printf("[ml] AI 서비스 예측 실패, 내장 모델로 계산: %v", err)
	}
	return embedded(days)
}

func (c *Client) remote(ctx context.Context, days []DayInput) (Result, error) {
	req := struct {
		Days []dayIn `json:"days"`
	}{Days: make([]dayIn, 0, len(days))}
	for _, d := range days {
		shows := make([]showIn, 0, len(d.Shows))
		for _, s := range d.Shows {
			shows = append(shows, showIn{Start: s.Start, Seats: s.Seats, Major: s.Major})
		}
		req.Days = append(req.Days, dayIn{Date: d.Date, DayType: d.DayType, Shows: shows})
	}
	body, _ := json.Marshal(req)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	hreq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/ml/forecast", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	hreq.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(hreq)
	if err != nil {
		return Result{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var out response
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return Result{}, err
	}
	if len(out.Forecasts) != len(days) {
		return Result{}, fmt.Errorf("예측 %d일을 요청했는데 %d일이 왔음", len(days), len(out.Forecasts))
	}
	result := Result{Model: out.Model, Thresholds: out.Thresholds, Days: map[string]DayForecast{}}
	result.Model.Source = "ml-service"
	for _, f := range out.Forecasts {
		result.Days[f.Date] = f.DayForecast
	}
	return result, nil
}

func embedded(days []DayInput) Result {
	result := Result{Model: model.Meta(), Thresholds: model.Thresholds(), Days: map[string]DayForecast{}}
	for _, d := range days {
		f := model.ForecastDay(d.DayType, d.Shows)
		result.Days[d.Date] = DayForecast{Bins: f.Bins, Peak: f.Peak}
	}
	return result
}
