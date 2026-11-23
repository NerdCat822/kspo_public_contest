package sources

import (
	"encoding/json"
	"fmt"
	"maps"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/config"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
)

type holidayItem struct {
	Locdate   any    `json:"locdate"`
	DateName  string `json:"dateName"`
	IsHoliday string `json:"isHoliday"`
}

// 한국천문연구원 특일정보: 해당 연·월의 공휴일 {"YYYY-MM-DD": 이름}
func (c *Client) holidayMonth(year, month int) (map[string]string, error) {
	return cache.Get(c.cache, fmt.Sprintf("holidays-%d-%02d", year, month), 24*time.Hour, true, func() (map[string]string, error) {
		ctx, cancel := bg(30 * time.Second)
		defer cancel()
		var res struct {
			Response struct {
				Body struct {
					Items json.RawMessage `json:"items"`
				} `json:"body"`
			} `json:"response"`
		}
		u := fmt.Sprintf("https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo?serviceKey=%s&solYear=%d&solMonth=%02d&numOfRows=50&_type=json",
			config.QueryKey(c.cfg.DataGoKrKey), year, month)
		if err := c.http.JSON(ctx, u, 15*time.Second, &res); err != nil {
			return nil, err
		}
		out := map[string]string{}
		for _, it := range holidayItems(res.Response.Body.Items) {
			if it.IsHoliday != "Y" {
				continue
			}
			d := str(it.Locdate)
			if len(d) == 8 {
				out[d[:4]+"-"+d[4:6]+"-"+d[6:]] = it.DateName
			}
		}
		return out, nil
	})
}

// items 는 빈 문자열, {"item": {...}}, {"item": [...]} 세 가지 형태로 온다.
func holidayItems(raw json.RawMessage) []holidayItem {
	var wrap struct {
		Item json.RawMessage `json:"item"`
	}
	if len(raw) == 0 || raw[0] != '{' || json.Unmarshal(raw, &wrap) != nil || len(wrap.Item) == 0 {
		return nil
	}
	var list []holidayItem
	if wrap.Item[0] == '[' {
		_ = json.Unmarshal(wrap.Item, &list)
		return list
	}
	var one holidayItem
	if json.Unmarshal(wrap.Item, &one) == nil {
		list = append(list, one)
	}
	return list
}

// Holidays 는 기간 안 공휴일이다. 못 받으면 비어 있는 값으로 두고 요일만으로 판단한다.
func (c *Client) Holidays(from, to string) map[string]string {
	out := map[string]string{}
	if c.cfg.DataGoKrKey == "" {
		return out
	}
	start, _ := kst.ParseYMD(from[:7] + "-01")
	end, _ := kst.ParseYMD(to)
	for m := start; !m.After(end); m = m.AddDate(0, 1, 0) {
		got, err := c.holidayMonth(m.Year(), int(m.Month()))
		if err != nil {
			continue
		}
		maps.Copy(out, got)
	}
	return out
}
