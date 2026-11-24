package sources

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/config"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

// 올림픽공원 기상청 격자
const kmaNX, kmaNY = 62, 126

var kmaBaseHours = []int{2, 5, 8, 11, 14, 17, 20, 23}

type kmaItem struct {
	Category  string `json:"category"`
	FcstDate  string `json:"fcstDate"`
	FcstTime  string `json:"fcstTime"`
	FcstValue string `json:"fcstValue"`
}

// 가장 최근 단기예보 발표 시각(발표 10분 뒤부터 조회 가능)
func latestBase() (date, tm string) {
	t := kst.Now().Add(-10 * time.Minute)
	for i := len(kmaBaseHours) - 1; i >= 0; i-- {
		if kmaBaseHours[i] <= t.Hour() {
			return t.Format("20060102"), fmt.Sprintf("%02d00", kmaBaseHours[i])
		}
	}
	return t.AddDate(0, 0, -1).Format("20060102"), "2300"
}

func (c *Client) forecastItems() ([]kmaItem, error) {
	date, tm := latestBase()
	return cache.Get(c.cache, "kma-vilage-"+date+"-"+tm, 3*time.Hour, false, func() ([]kmaItem, error) {
		ctx, cancel := bg(40 * time.Second)
		defer cancel()
		var res struct {
			Response struct {
				Header struct {
					ResultCode string `json:"resultCode"`
					ResultMsg  string `json:"resultMsg"`
				} `json:"header"`
				Body struct {
					Items struct {
						Item []kmaItem `json:"item"`
					} `json:"items"`
				} `json:"body"`
			} `json:"response"`
		}
		u := fmt.Sprintf("https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=%s&pageNo=1&numOfRows=1200&dataType=JSON&base_date=%s&base_time=%s&nx=%d&ny=%d",
			config.QueryKey(c.cfg.DataGoKrKey), date, tm, kmaNX, kmaNY)
		if err := c.http.JSON(ctx, u, 20*time.Second, &res); err != nil {
			return nil, err
		}
		if h := res.Response.Header; h.ResultCode != "" && h.ResultCode != "00" {
			return nil, fmt.Errorf("기상청 %s %s", h.ResultCode, h.ResultMsg)
		}
		return res.Response.Body.Items.Item, nil
	})
}

var skyNames = map[string]string{"1": "맑음", "3": "구름많음", "4": "흐림"}
var ptyNames = map[string]string{"1": "비", "2": "비/눈", "3": "눈", "4": "소나기"}

// DayWeather 는 기상청 단기예보로 그날 날씨를 요약한다(오늘~3일 뒤). 범위 밖이면 nil.
func (c *Client) DayWeather(date string) (*types.DayWeather, error) {
	if c.cfg.DataGoKrKey == "" {
		return nil, nil
	}
	items, err := c.forecastItems()
	if err != nil {
		return nil, err
	}
	day := strings.ReplaceAll(date, "-", "")
	by := map[string][]kmaItem{}
	for _, it := range items {
		if it.FcstDate == day {
			by[it.Category] = append(by[it.Category], it)
		}
	}
	temps := floats(by["TMP"])
	if len(temps) < 12 { // 예보 범위 끝자락이라 하루치가 다 없으면 요약하지 않는다
		return nil, nil
	}
	w := &types.DayWeather{Source: "kma"}
	if v := floats(by["TMN"]); len(v) > 0 {
		w.MinTemp = types.Ptr(v[0])
	} else {
		w.MinTemp = types.Ptr(minOf(temps))
	}
	if v := floats(by["TMX"]); len(v) > 0 {
		w.MaxTemp = types.Ptr(v[0])
	} else {
		w.MaxTemp = types.Ptr(maxOf(temps))
	}
	if pops := floats(by["POP"]); len(pops) > 0 {
		w.RainChance = types.Ptr(maxOf(pops))
	}
	w.PrecipType, w.PrecipFrom, w.PrecipTo = precipWindow(by["PTY"])
	// 낮 시간(09~21시) 하늘 상태 중 가장 흔한 값
	counts := map[string]int{}
	for _, it := range by["SKY"] {
		if t, _ := strconv.Atoi(it.FcstTime); t >= 900 && t <= 2100 {
			counts[it.FcstValue]++
		}
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		return counts[keys[i]] > counts[keys[j]] || (counts[keys[i]] == counts[keys[j]] && keys[i] < keys[j])
	})
	if len(keys) > 0 {
		if name, ok := skyNames[keys[0]]; ok {
			w.Sky = types.Ptr(name)
		}
	}
	return w, nil
}

// precipWindow 는 강수 형태(PTY) 예보에서 가장 이른 강수의 종류와, 강수가 예보된 시간대를 뽑는다.
// 시간대는 첫 시각 ~ 마지막 시각의 한 시간 뒤(시간 단위 예보라서)이고, 중간에 그치는 때가 있어도 하나로 묶는다.
func precipWindow(pty []kmaItem) (kind, from, to *string) {
	first, last, code := "", "", ""
	for _, it := range pty {
		if it.FcstValue == "0" || len(it.FcstTime) != 4 {
			continue
		}
		if first == "" || it.FcstTime < first {
			first, code = it.FcstTime, it.FcstValue
		}
		if it.FcstTime > last {
			last = it.FcstTime
		}
	}
	if first == "" {
		return nil, nil, nil
	}
	if name, ok := ptyNames[code]; ok {
		kind = types.Ptr(name)
	}
	endHour, _ := strconv.Atoi(last[:2])
	return kind, types.Ptr(first[:2] + ":" + first[2:]), types.Ptr(fmt.Sprintf("%02d:00", endHour+1))
}

func floats(items []kmaItem) []float64 {
	out := make([]float64, 0, len(items))
	for _, it := range items {
		if f, err := strconv.ParseFloat(it.FcstValue, 64); err == nil {
			out = append(out, f)
		}
	}
	return out
}

func minOf(v []float64) float64 {
	m := v[0]
	for _, x := range v[1:] {
		if x < m {
			m = x
		}
	}
	return m
}

func maxOf(v []float64) float64 {
	m := v[0]
	for _, x := range v[1:] {
		if x > m {
			m = x
		}
	}
	return m
}
