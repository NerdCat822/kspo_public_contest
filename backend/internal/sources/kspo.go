package sources

import (
	"encoding/json"
	"errors"
	"net/url"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
)

type ParkingSum struct {
	Sum int    `json:"sum"`
	At  string `json:"at"`
}

// ParkingSum 은 한국체육산업개발 실시간 주차현황(공공데이터포털 15168686).
// 동2문·남2문·북2문 주차구역의 현재 주차대수 합계 하나만 준다.
func (c *Client) ParkingSum() (ParkingSum, error) {
	return cache.Get(c.cache, "kspo-parking", time.Minute, false, func() (ParkingSum, error) {
		ctx, cancel := bg(20 * time.Second)
		defer cancel()
		b, err := c.http.Text(ctx, "https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey="+url.QueryEscape(c.cfg.KspoParkingKey), 15*time.Second)
		if err != nil {
			return ParkingSum{}, err
		}
		var data []map[string]any
		if err := json.Unmarshal(b, &data); err != nil || len(data) == 0 {
			return ParkingSum{}, errors.New("parking_sum 없음")
		}
		v, ok := data[0]["parking_sum"]
		if !ok {
			return ParkingSum{}, errors.New("parking_sum 없음")
		}
		return ParkingSum{Sum: int(num(v)), At: kst.Stamp(kst.Now())}, nil
	})
}
