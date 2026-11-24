// Package api 는 화면이 부르는 HTTP API(Gin)다. 응답 형태는 internal/types 참고.
package api

import (
	"context"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/collector"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/config"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/ml"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/model"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/sources"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

type Server struct {
	cfg       config.Config
	src       *sources.Client
	collector *collector.Collector
	ml        *ml.Client
	agent     http.Handler
	usual     usualCache // "평소 이 시각" 주차대수(usual.go)
}

func New(cfg config.Config, src *sources.Client, col *collector.Collector) *Server {
	return &Server{cfg: cfg, src: src, collector: col, ml: ml.New(cfg.AIServiceURL), agent: agentProxy(cfg.AIServiceURL)}
}

// Register 는 /api 아래 라우트를 붙인다.
func (s *Server) Register(r gin.IRouter) {
	g := r.Group("/api")
	g.GET("/health", s.health)
	g.GET("/config", s.config)
	g.GET("/overview", s.overview)
	g.GET("/day", s.day)
	g.GET("/shows", s.shows)
	g.GET("/live", s.live)
	// 상담 에이전트는 Python AI 서비스가 맡는다: /api/agent/chat → AI 서비스 /agent/chat
	g.Any("/agent/*path", gin.WrapH(s.agent))
}

func (s *Server) health(c *gin.Context) {
	storage := "files"
	if s.cfg.DatabaseURL != "" {
		storage = "postgres"
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":      true,
		"at":      kst.Stamp(kst.Now()),
		"storage": storage, // 수집 기록·API 캐시를 남기는 곳
		"keys": gin.H{
			"kopis": s.cfg.KopisKey != "", "seoul": s.cfg.SeoulKey != "",
			"dataGoKr": s.cfg.DataGoKrKey != "", "culture": s.cfg.CultureKey != "",
			"naverMap": s.cfg.NaverMapClientID != "",
		},
	})
}

// config 는 화면이 쓰는 공개 설정이다. 네이버 지도 Client ID 는 스크립트 주소에 들어가는 공개 값이라 내려준다
// (Web 서비스 URL 로 등록한 도메인에서만 동작). Client Secret 은 내려주지 않는다.
func (s *Server) config(c *gin.Context) {
	out := types.ConfigResponse{}
	if s.cfg.NaverMapClientID != "" {
		out.NaverMapClientID = types.Ptr(s.cfg.NaverMapClientID)
	}
	c.JSON(http.StatusOK, out)
}

func dayTypeOf(date string, holidays map[string]string) types.DayType {
	if _, ok := holidays[date]; ok {
		return types.Holiday
	}
	if w := kst.Weekday(date); w == 0 || w == 6 {
		return types.Weekend
	}
	return types.Weekday
}

// showsAndHolidays 는 공연 일정을 기간 단위로 한 번에 받는다. 실패하면 공연 없이 기준선만으로 예측한다.
func (s *Server) showsAndHolidays(from, to string) (map[string]string, map[string][]types.Show, map[string]string) {
	holidays := s.src.Holidays(from, to)
	errs := map[string]string{}
	shows, err := s.src.ShowsByDate(from, to, holidays)
	if err != nil {
		errs["shows"] = err.Error()
		shows = map[string][]types.Show{}
	}
	return holidays, shows, errs
}

func holidayName(holidays map[string]string, date string) *string {
	if n, ok := holidays[date]; ok {
		return types.Ptr(n)
	}
	return nil
}

func daysParam(c *gin.Context, def int) int {
	days, err := strconv.Atoi(c.DefaultQuery("days", strconv.Itoa(def)))
	if err != nil {
		days = def
	}
	return min(max(days, 1), 31)
}

func (s *Server) overview(c *gin.Context) {
	days := daysParam(c, 14)
	from := kst.Today()
	to := kst.AddDays(from, days-1)
	holidays, shows, errs := s.showsAndHolidays(from, to)

	inputs := []ml.DayInput{}
	for d := from; d <= to; d = kst.AddDays(d, 1) {
		inputs = append(inputs, ml.DayInput{Date: d, DayType: dayTypeOf(d, holidays), Shows: shows[d]})
	}
	forecast := s.ml.Forecast(c.Request.Context(), inputs)

	out := types.OverviewResponse{Days: []types.OverviewDay{}, Errors: errs}
	for _, in := range inputs {
		major := []types.MajorShow{}
		for _, sh := range in.Shows {
			if sh.Major {
				major = append(major, types.MajorShow{Name: sh.Name, Hall: sh.Hall, Start: sh.Start, Seats: sh.Seats})
			}
		}
		f := forecast.Days[in.Date]
		out.Days = append(out.Days, types.OverviewDay{
			Date: in.Date, Weekday: kst.Weekdays[kst.Weekday(in.Date)], DayType: in.DayType, HolidayName: holidayName(holidays, in.Date),
			PeakLevel: f.Peak.Level, PeakTime: f.Peak.T, MajorShows: major,
		})
	}
	c.JSON(http.StatusOK, out)
}

func (s *Server) day(c *gin.Context) {
	date := c.DefaultQuery("date", kst.Today())
	if _, ok := kst.ParseYMD(date); !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "date 는 YYYY-MM-DD 형식이어야 합니다."})
		return
	}
	holidays, shows, errs := s.showsAndHolidays(date, date)
	list := shows[date]
	if list == nil {
		list = []types.Show{}
	}
	dt := dayTypeOf(date, holidays)
	forecast := s.ml.Forecast(c.Request.Context(), []ml.DayInput{{Date: date, DayType: dt, Shows: list}})
	f := forecast.Days[date]
	weather, _ := s.src.DayWeather(date) // 날씨는 부가 정보라 실패해도 비워 둔다

	concert := []types.ConcertAdvice{}
	for _, sh := range list {
		concert = append(concert, model.ConcertAdvice(sh, f.Bins, forecast.Model.ExitMinutes))
	}
	c.JSON(http.StatusOK, types.DayResponse{
		Date: date, Weekday: kst.Weekdays[kst.Weekday(date)], DayType: dt, HolidayName: holidayName(holidays, date),
		Shows:    list,
		Forecast: types.Forecast{Bins: f.Bins, Peak: f.Peak, Thresholds: forecast.Thresholds},
		Advice:   types.Advice{Concert: concert, Park: model.ParkAdvice(f.Bins)},
		Weather:  weather, Model: forecast.Model, Errors: errs,
	})
}

// shows 는 오늘부터 며칠 동안의 모든 공연 회차다(소규모 포함). 상담 에이전트의 공연 검색이 쓴다.
func (s *Server) shows(c *gin.Context) {
	days := daysParam(c, 31)
	from := kst.Today()
	to := kst.AddDays(from, days-1)
	_, shows, errs := s.showsAndHolidays(from, to)
	out := types.ShowsResponse{Shows: []types.ShowItem{}, Errors: errs}
	for date, list := range shows {
		for _, sh := range list {
			out.Shows = append(out.Shows, types.ShowItem{Date: date, Start: sh.Start, End: sh.End, Name: sh.Name, Hall: sh.Hall, Seats: sh.Seats, Major: sh.Major})
		}
	}
	sort.Slice(out.Shows, func(i, j int) bool {
		a, b := out.Shows[i], out.Shows[j]
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		return a.Start < b.Start
	})
	c.JSON(http.StatusOK, out)
}

func (s *Server) live(c *gin.Context) {
	var (
		wg               sync.WaitGroup
		parking          sources.ParkingSum
		city             sources.CityData
		nearby           []types.Control
		pErr, cErr, aErr error
	)
	wg.Add(3)
	go func() { defer wg.Done(); parking, pErr = s.src.ParkingSum() }()
	go func() { defer wg.Done(); city, cErr = s.src.CityData() }()
	go func() { defer wg.Done(); nearby, aErr = s.src.NearbyControls() }()
	wg.Wait()

	out := types.LiveResponse{
		FetchedAt: kst.Stamp(kst.Now()),
		Lots:      []types.ParkingLot{}, Stations: []types.Station{}, Controls: []types.Control{},
		Alerts: []types.Notice{}, News: []types.Notice{},
		Errors: map[string]string{},
	}
	if pErr != nil {
		out.Errors["parking"] = pErr.Error()
	} else {
		today := []types.ParkingPoint{}
		for _, r := range s.collector.Day(kst.Today()) {
			if r.Parking != nil {
				today = append(today, types.ParkingPoint{At: r.At, Sum: *r.Parking})
			}
		}
		out.Parking = &types.Parking{Sum: parking.Sum, At: parking.At, Today: today, Usual: s.usualParking()}
	}
	if cErr != nil {
		out.Errors["city"] = cErr.Error()
	} else {
		out.Population, out.Road, out.Weather = city.Population, city.Road, city.Weather
		out.Lots, out.Stations = city.Lots, city.Stations
		out.Alerts, out.News = city.Alerts, city.News
		out.Controls = append(out.Controls, city.Controls...)
	}
	if aErr != nil {
		out.Errors["controls"] = aErr.Error()
	}
	// 도시데이터의 통제와 같은 내용은 한 번만 보여 준다.
	seen := map[string]bool{}
	for _, x := range out.Controls {
		seen[x.Info] = true
	}
	for _, x := range nearby {
		if !seen[x.Info] {
			out.Controls = append(out.Controls, x)
		}
	}
	c.JSON(http.StatusOK, out)
}

// agentProxy 는 /api/agent/* 요청을 AI 서비스의 /agent/* 로 넘긴다. AI 서비스가 꺼져 있으면
// FastAPI 오류와 같은 모양({"detail": {...}})으로 502 를 돌려준다.
func agentProxy(aiURL string) http.Handler {
	target, err := url.Parse(aiURL)
	if err != nil || aiURL == "" {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeAgentError(w, http.StatusServiceUnavailable, "ai_disabled", "AI 서비스 주소가 설정되지 않았어요.")
		})
	}
	proxy := &httputil.ReverseProxy{
		// 상담 답(/agent/chat/stream, text/event-stream)은 받는 즉시 화면으로 흘려보낸다
		FlushInterval: -1,
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, "/api")
			pr.Out.URL.RawPath = ""
			pr.Out.Host = target.Host
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if r.Context().Err() == context.Canceled {
				return
			}
			writeAgentError(w, http.StatusBadGateway, "ai_unreachable", "AI 서비스에 연결하지 못했어요.")
		},
	}
	return proxy
}

func writeAgentError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"detail":{"code":"` + code + `","message":"` + message + `"}}`))
}
