package sources

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

// 서울시 실시간 도시데이터: 올림픽공원 장소코드
const cityArea = "POI127"

type CityData struct {
	Population *types.Population  `json:"population"`
	Road       *types.Road        `json:"road"`
	Weather    *types.Weather     `json:"weather"`
	Lots       []types.ParkingLot `json:"lots"`
	Stations   []types.Station    `json:"stations"`
	Controls   []types.Control    `json:"controls"`
}

// CityData 는 5분마다 갱신되는 서울시 실시간 도시데이터를 올림픽공원 기준으로 정리한다.
func (c *Client) CityData() (CityData, error) {
	return cache.Get(c.cache, "seoul-citydata", 5*time.Minute, false, func() (CityData, error) {
		if c.cfg.SeoulKey == "" {
			return CityData{}, errors.New("SEOUL_API_KEY 없음")
		}
		ctx, cancel := bg(60 * time.Second)
		defer cancel()
		var res map[string]any
		u := fmt.Sprintf("http://openapi.seoul.go.kr:8088/%s/json/citydata/1/5/%s", url.QueryEscape(c.cfg.SeoulKey), cityArea)
		if err := c.http.JSON(ctx, u, 25*time.Second, &res); err != nil {
			return CityData{}, err
		}
		city := obj(res["CITYDATA"])
		if city == nil {
			return CityData{}, fmt.Errorf("도시데이터 응답 없음: %s", str(obj(res["RESULT"])["RESULT.MESSAGE"]))
		}
		return normalizeCity(city), nil
	})
}

var seoulPrefix = regexp.MustCompile(`^서울\s?송파\s?`)

func normalizeCity(c map[string]any) CityData {
	out := CityData{Lots: []types.ParkingLot{}, Stations: []types.Station{}, Controls: []types.Control{}}

	if pops := arr(c["LIVE_PPLTN_STTS"]); len(pops) > 0 {
		p := obj(pops[0])
		fc := []types.PopulationForecast{}
		for _, f := range arr(p["FCST_PPLTN"]) {
			fm := obj(f)
			fc = append(fc, types.PopulationForecast{At: str(fm["FCST_TIME"]), Level: str(fm["FCST_CONGEST_LVL"])})
		}
		out.Population = &types.Population{
			Level:    str(p["AREA_CONGEST_LVL"]),
			Message:  str(p["AREA_CONGEST_MSG"]),
			Min:      int(num(p["AREA_PPLTN_MIN"])),
			Max:      int(num(p["AREA_PPLTN_MAX"])),
			At:       str(p["PPLTN_TIME"]),
			Forecast: fc,
		}
	}

	if road := obj(c["ROAD_TRAFFIC_STTS"]); road != nil {
		links := []types.RoadLink{}
		for _, l := range arr(road["ROAD_TRAFFIC_STTS"]) {
			lm := obj(l)
			path := [][2]float64{}
			for _, p := range strings.Split(str(lm["XYLIST"]), "|") {
				x, y, ok := strings.Cut(p, "_")
				if !ok {
					continue
				}
				lng, lat := num(x), num(y)
				if lng != 0 && lat != 0 {
					path = append(path, [2]float64{lng, lat})
				}
			}
			links = append(links, types.RoadLink{
				ID: str(lm["LINK_ID"]), Name: str(lm["ROAD_NM"]), From: str(lm["START_ND_NM"]), To: str(lm["END_ND_NM"]),
				Speed: num(lm["SPD"]), Idx: str(lm["IDX"]), Path: path,
			})
		}
		if avg := obj(road["AVG_ROAD_DATA"]); avg != nil {
			out.Road = &types.Road{
				Level: str(avg["ROAD_TRAFFIC_IDX"]), Speed: num(avg["ROAD_TRAFFIC_SPD"]),
				Message: str(avg["ROAD_MSG"]), At: str(avg["ROAD_TRAFFIC_TIME"]), Links: links,
			}
		}
	}

	if ws := arr(c["WEATHER_STTS"]); len(ws) > 0 {
		w := obj(ws[0])
		var sky *string
		if fc := arr(w["FCST24HOURS"]); len(fc) > 0 {
			if s := str(obj(fc[0])["SKY_STTS"]); s != "" {
				sky = types.Ptr(s)
			}
		}
		out.Weather = &types.Weather{
			Temp: num(w["TEMP"]), Sky: sky, PrecipType: str(w["PRECPT_TYPE"]),
			Message: str(w["PCP_MSG"]), PM10Level: str(w["PM10_INDEX"]), At: str(w["WEATHER_TIME"]),
		}
	}

	for _, p := range arr(c["PRK_STTS"]) {
		pm := obj(p)
		name := strings.TrimSpace(seoulPrefix.ReplaceAllString(str(pm["PRK_NM"]), ""))
		if name == "" {
			name = str(pm["PRK_NM"])
		}
		var fee *string
		if rate, per := int(num(pm["RATES"])), int(num(pm["TIME_RATES"])); rate > 0 && per > 0 {
			fee = types.Ptr(fmt.Sprintf("%d분 %s원", per, commas(rate)))
		}
		out.Lots = append(out.Lots, types.ParkingLot{
			ID: str(pm["PRK_CD"]), Name: name, Capacity: int(num(pm["CPCTY"])),
			Lat: num(pm["LAT"]), Lng: num(pm["LNG"]), Address: str(pm["ADDRESS"]), Fee: fee,
		})
	}

	for _, s := range arr(c["SUB_STTS"]) {
		sm := obj(s)
		out.Stations = append(out.Stations, types.Station{
			Name: str(sm["SUB_STN_NM"]), Line: str(sm["SUB_STN_LINE"]), Lat: num(sm["SUB_STN_Y"]), Lng: num(sm["SUB_STN_X"]),
		})
	}

	for i, a := range arr(c["ACDNT_CNTRL_STTS"]) {
		am := obj(a)
		kind := str(am["ACDNT_TYPE"])
		if kind == "" {
			kind = "통제"
		}
		ctl := types.Control{ID: fmt.Sprintf("city-%d", i), Kind: kind, Info: str(am["ACDNT_INFO"]), DistanceM: types.Ptr(0)}
		if v := str(am["ACDNT_OCCR_DT"]); v != "" {
			ctl.From = types.Ptr(v)
		}
		if v := str(am["EXP_CLR_DT"]); v != "" {
			ctl.To = types.Ptr(v)
		}
		if lat, lng := num(am["ACDNT_Y"]), num(am["ACDNT_X"]); lat != 0 && lng != 0 {
			ctl.Lat, ctl.Lng = types.Ptr(lat), types.Ptr(lng)
		}
		out.Controls = append(out.Controls, ctl)
	}
	return out
}
