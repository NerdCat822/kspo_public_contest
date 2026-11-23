package sources

import (
	"encoding/xml"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/geo"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

// 서울시 돌발 유형 코드(AccMainCode·AccSubCode API 기준)
var accMain = map[string]string{
	"A01": "교통사고", "A02": "차량고장", "A03": "보행사고", "A04": "공사", "A05": "낙하물",
	"A06": "버스사고", "A07": "지하철사고", "A08": "화재", "A09": "기상·재난", "A10": "집회·행사",
	"A11": "기타", "A12": "제보", "A13": "단순정보",
}
var accSub = map[string]string{"10B02": "집회", "10B03": "행사", "04B01": "시설물보수", "04B04": "도로보수", "04B06": "포장공사"}

const accRadiusM = 3000

type accRow struct {
	ID       string `xml:"acc_id"`
	OccrDate string `xml:"occr_date"`
	OccrTime string `xml:"occr_time"`
	ClrDate  string `xml:"exp_clr_date"`
	ClrTime  string `xml:"exp_clr_time"`
	Type     string `xml:"acc_type"`
	DType    string `xml:"acc_dtype"`
	X        string `xml:"grs80tm_x"`
	Y        string `xml:"grs80tm_y"`
	Info     string `xml:"acc_info"`
}

var newlines = regexp.MustCompile(`\s*\r?\n\s*`)

func accStamp(date, tm string) *string {
	if len(date) != 8 {
		return nil
	}
	t := (tm + "0000")[:4]
	s := fmt.Sprintf("%s-%s-%s %s:%s", date[:4], date[4:6], date[6:8], t[:2], t[2:4])
	return &s
}

// NearbyControls 는 서울시 실시간 돌발정보 중 올림픽공원 반경 3km 안의 사고·공사·통제다.
func (c *Client) NearbyControls() ([]types.Control, error) {
	return cache.Get(c.cache, "seoul-accinfo", 5*time.Minute, false, func() ([]types.Control, error) {
		if c.cfg.SeoulKey == "" {
			return nil, errors.New("SEOUL_API_KEY 없음")
		}
		ctx, cancel := bg(40 * time.Second)
		defer cancel()
		b, err := c.http.Text(ctx, fmt.Sprintf("http://openapi.seoul.go.kr:8088/%s/xml/AccInfo/1/300/", url.QueryEscape(c.cfg.SeoulKey)), 15*time.Second)
		if err != nil {
			return nil, err
		}
		var res struct {
			Rows []accRow `xml:"row"`
		}
		if err := xml.Unmarshal(b, &res); err != nil {
			return nil, fmt.Errorf("돌발정보 XML 해석 실패: %v", err)
		}
		cx, cy := geo.ToTM(geo.ParkCenter.Lat, geo.ParkCenter.Lng)
		out := []types.Control{}
		for _, r := range res.Rows {
			x, errX := strconv.ParseFloat(r.X, 64)
			y, errY := strconv.ParseFloat(r.Y, 64)
			if errX != nil || errY != nil {
				continue
			}
			d := int(math.Round(math.Hypot(x-cx, y-cy)))
			if d > accRadiusM {
				continue
			}
			kind := accSub[r.DType]
			if kind == "" {
				kind = accMain[r.Type]
			}
			if kind == "" {
				kind = "돌발"
			}
			lat, lng := geo.FromTM(x, y)
			out = append(out, types.Control{
				ID: r.ID, Kind: kind, Info: strings.TrimSpace(newlines.ReplaceAllString(r.Info, " ")),
				From: accStamp(r.OccrDate, r.OccrTime), To: accStamp(r.ClrDate, r.ClrTime),
				DistanceM: types.Ptr(d), Lat: types.Ptr(lat), Lng: types.Ptr(lng),
			})
		}
		sort.SliceStable(out, func(i, j int) bool { return *out[i].DistanceM < *out[j].DistanceM })
		return out, nil
	})
}
