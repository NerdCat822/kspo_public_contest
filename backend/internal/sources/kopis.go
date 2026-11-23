package sources

import (
	"encoding/xml"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

const (
	kopisBase = "http://www.kopis.or.kr/openApi/restful"
	// KOPIS 공연시설 ID: 올림픽공원
	kopisFacility = "FC001247"
	// MajorMinSeats 이상 공연장만 예측에 반영한다.
	MajorMinSeats = 2000
	// 런타임이 비어 있을 때 쓰는 기본값(분). 2024년 7월 대형 공연 평균에 가깝게 잡았다.
	defaultRuntime = 150
)

type Hall struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Seats int    `json:"seats"`
}

type PerfDetail struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Genre    string `json:"genre"`
	From     string `json:"from"`
	To       string `json:"to"`
	Facility string `json:"facility"`
	HallID   string `json:"hallId"`
	Schedule string `json:"schedule"`
	Runtime  string `json:"runtime"`
}

type kopisDB struct {
	ID       string `xml:"mt20id"`
	HallID   string `xml:"mt13id"`
	Name     string `xml:"prfnm"`
	From     string `xml:"prfpdfrom"`
	To       string `xml:"prfpdto"`
	Facility string `xml:"fcltynm"`
	Runtime  string `xml:"prfruntime"`
	Genre    string `xml:"genrenm"`
	Schedule string `xml:"dtguidance"`
	Halls    []struct {
		ID    string `xml:"mt13id"`
		Name  string `xml:"prfplcnm"`
		Seats string `xml:"seatscale"`
	} `xml:"mt13s>mt13"`
}

func (c *Client) kopisGet(path string, query string) ([]kopisDB, error) {
	if c.cfg.KopisKey == "" {
		return nil, errors.New("KOPIS_API_KEY 없음")
	}
	ctx, cancel := bg(40 * time.Second)
	defer cancel()
	u := fmt.Sprintf("%s/%s?service=%s%s", kopisBase, path, url.QueryEscape(c.cfg.KopisKey), query)
	b, err := c.http.Text(ctx, u, 15*time.Second)
	if err != nil {
		return nil, err
	}
	var res struct {
		DB []kopisDB `xml:"db"`
	}
	if err := xml.Unmarshal(b, &res); err != nil {
		return nil, fmt.Errorf("KOPIS XML 해석 실패: %v", err)
	}
	return res.DB, nil
}

// Halls 는 올림픽공원 안 공연장(관)별 좌석 수
func (c *Client) Halls() ([]Hall, error) {
	return cache.Get(c.cache, "kopis-halls", 7*24*time.Hour, true, func() ([]Hall, error) {
		dbs, err := c.kopisGet("prfplc/"+kopisFacility, "")
		if err != nil {
			return nil, err
		}
		if len(dbs) == 0 {
			return nil, errors.New("KOPIS 공연시설 응답 없음")
		}
		out := []Hall{}
		for _, h := range dbs[0].Halls {
			seats, _ := strconv.Atoi(strings.ReplaceAll(h.Seats, ",", ""))
			out = append(out, Hall{ID: h.ID, Name: strings.TrimSpace(h.Name), Seats: seats})
		}
		return out, nil
	})
}

func (c *Client) listIDs(from, to string) ([]string, error) {
	return cache.Get(c.cache, fmt.Sprintf("kopis-list-%s-%s", from, to), 6*time.Hour, true, func() ([]string, error) {
		ids := []string{}
		for page := 1; page <= 10; page++ {
			q := fmt.Sprintf("&stdate=%s&eddate=%s&cpage=%d&rows=100&signgucode=11&signgucodesub=1171",
				strings.ReplaceAll(from, "-", ""), strings.ReplaceAll(to, "-", ""), page)
			dbs, err := c.kopisGet("pblprfr", q)
			if err != nil {
				return nil, err
			}
			for _, d := range dbs {
				if strings.Contains(d.Facility, "올림픽공원") {
					ids = append(ids, d.ID)
				}
			}
			if len(dbs) < 100 {
				break
			}
		}
		return ids, nil
	})
}

func (c *Client) detail(id string) (PerfDetail, error) {
	return cache.Get(c.cache, "kopis-detail-"+id, 12*time.Hour, true, func() (PerfDetail, error) {
		dbs, err := c.kopisGet("pblprfr/"+id, "")
		if err != nil {
			return PerfDetail{}, err
		}
		if len(dbs) == 0 {
			return PerfDetail{}, fmt.Errorf("KOPIS 공연상세 없음: %s", id)
		}
		d := dbs[0]
		return PerfDetail{
			ID: id, Name: d.Name, Genre: d.Genre,
			From: strings.ReplaceAll(d.From, ".", "-"), To: strings.ReplaceAll(d.To, ".", "-"),
			Facility: d.Facility, HallID: d.HallID, Schedule: d.Schedule, Runtime: d.Runtime,
		}, nil
	})
}

var (
	scheduleRe = regexp.MustCompile(`([^(),]+)\(([^)]*)\)`)
	timeRe     = regexp.MustCompile(`^\d{1,2}:\d{2}$`)
	hoursRe    = regexp.MustCompile(`(\d+)\s*시간`)
	minsRe     = regexp.MustCompile(`(\d+)\s*분`)
	hallNameRe = regexp.MustCompile(`^[^(]*\((.*)\)\s*$`)
	dayNames   = []string{"월", "화", "수", "목", "금", "토", "일"}
)

// HolidayKey 는 KOPIS 일정의 'HOL'(공휴일) 항목
const HolidayKey = 7

// ParseSchedule 은 '화요일 ~ 금요일(11:00,14:00), 토요일(18:00), HOL(14:00)' 를
// 요일(0=월 … 6=일, 7=HOL)별 시작 시각으로 바꾼다.
func ParseSchedule(text string) map[int][]string {
	out := map[int][]string{}
	for _, m := range scheduleRe.FindAllStringSubmatch(text, -1) {
		spec := strings.TrimSpace(m[1])
		times := []string{}
		for t := range strings.SplitSeq(m[2], ",") {
			t = strings.TrimSpace(t)
			if timeRe.MatchString(t) {
				if len(t) == 4 {
					t = "0" + t
				}
				times = append(times, t)
			}
		}
		if strings.EqualFold(spec, "HOL") {
			out[HolidayKey] = append(out[HolidayKey], times...)
			continue
		}
		parts := strings.Split(spec, "~")
		idx := make([]int, 0, len(parts))
		for _, p := range parts {
			r := []rune(strings.TrimSpace(p))
			i := -1
			if len(r) > 0 {
				i = indexOf(dayNames, string(r[0]))
			}
			if i < 0 {
				idx = nil
				break
			}
			idx = append(idx, i)
		}
		if len(idx) == 0 {
			continue
		}
		a, b := idx[0], idx[len(idx)-1]
		for i := range 7 {
			d := (a + i) % 7
			out[d] = append(out[d], times...)
			if d == b {
				break
			}
		}
	}
	return out
}

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -1
}

// ParseRuntime 은 '2시간 30분' → 150. 없으면 0.
func ParseRuntime(text string) int {
	total := 0
	if m := hoursRe.FindStringSubmatch(text); m != nil {
		h, _ := strconv.Atoi(m[1])
		total += h * 60
	}
	if m := minsRe.FindStringSubmatch(text); m != nil {
		n, _ := strconv.Atoi(m[1])
		total += n
	}
	return total
}

// hallOf 는 공연상세의 공연장 ID로 찾고, 없으면 '올림픽공원 (KSPO DOME(체조경기장))' 의 괄호 안 이름으로 찾는다.
func hallOf(p PerfDetail, halls []Hall) *Hall {
	for i := range halls {
		if p.HallID != "" && halls[i].ID == p.HallID {
			return &halls[i]
		}
	}
	inner := ""
	if m := hallNameRe.FindStringSubmatch(p.Facility); m != nil {
		inner = strings.TrimSpace(m[1])
	}
	for i := range halls {
		if halls[i].Name == inner {
			return &halls[i]
		}
	}
	for i := range halls {
		if inner != "" && (strings.Contains(inner, halls[i].Name) || strings.Contains(halls[i].Name, inner)) {
			return &halls[i]
		}
	}
	return nil
}

var facilityPrefix = regexp.MustCompile(`^올림픽공원\s*`)

// ShowsByDate 는 기간 안 날짜별 올림픽공원 공연 회차다.
// holidays 에 든 날짜는 KOPIS 의 HOL 일정이 있으면 그것을 쓴다.
func (c *Client) ShowsByDate(from, to string, holidays map[string]string) (map[string][]types.Show, error) {
	halls, err := c.Halls()
	if err != nil {
		return nil, err
	}
	ids, err := c.listIDs(from, to)
	if err != nil {
		return nil, err
	}
	details := make([]PerfDetail, 0, len(ids))
	for _, id := range ids { // KOPIS 부하를 줄이려 순차 호출(캐시됨)
		d, err := c.detail(id)
		if err != nil {
			return nil, err
		}
		details = append(details, d)
	}

	byDate := map[string][]types.Show{}
	for d := from; d <= to; d = kst.AddDays(d, 1) {
		byDate[d] = []types.Show{}
	}
	for _, p := range details {
		hall := hallOf(p, halls)
		schedule := ParseSchedule(p.Schedule)
		runtime := ParseRuntime(p.Runtime)
		for date := range byDate {
			if date < p.From || date > p.To {
				continue
			}
			dow := (kst.Weekday(date) + 6) % 7 // 0=월
			times := schedule[dow]
			if _, isHoliday := holidays[date]; isHoliday && len(schedule[HolidayKey]) > 0 {
				times = schedule[HolidayKey]
			}
			for _, start := range times {
				rt := runtime
				if rt == 0 {
					rt = defaultRuntime
				}
				s := types.Show{
					ID: fmt.Sprintf("%s-%s-%s", p.ID, date, start), Name: p.Name, Start: start,
					End: kst.HHMM(kst.ToMinutes(start) + rt), RuntimeMin: rt, RuntimeKnown: runtime > 0, Genre: p.Genre,
				}
				if hall != nil {
					s.Hall, s.Seats = hall.Name, hall.Seats
				} else {
					s.Hall = strings.Trim(facilityPrefix.ReplaceAllString(p.Facility, ""), "()")
				}
				s.Major = s.Seats >= MajorMinSeats
				byDate[date] = append(byDate[date], s)
			}
		}
	}
	for date, list := range byDate {
		sort.SliceStable(list, func(i, j int) bool {
			if list[i].Seats != list[j].Seats {
				return list[i].Seats > list[j].Seats
			}
			return list[i].Start < list[j].Start
		})
		byDate[date] = list
	}
	return byDate, nil
}
