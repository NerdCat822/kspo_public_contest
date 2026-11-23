// Package types 는 화면과 주고받는 API 계약이다.
// app/shared/types.ts 와 필드 이름·형태가 같아야 한다(바꾸면 양쪽을 함께 바꾼다).
// null 이 될 수 있는 값은 포인터, 목록은 비어 있어도 [] 로 내보내도록 nil 이 아닌 슬라이스로 둔다.
package types

// Level 은 혼잡 단계. 서울시 실시간 도시데이터의 인구 혼잡 용어와 맞췄다.
type Level string

const (
	Calm   Level = "calm"   // 여유
	Normal Level = "normal" // 보통
	Busy   Level = "busy"   // 붐빔
	Jam    Level = "jam"    // 매우 붐빔
)

// Rank 는 단계의 순서
func (l Level) Rank() int {
	switch l {
	case Normal:
		return 1
	case Busy:
		return 2
	case Jam:
		return 3
	}
	return 0
}

type DayType string

const (
	Weekday DayType = "weekday"
	Weekend DayType = "weekend"
	Holiday DayType = "holiday"
)

// Show 는 그날 열리는 공연 회차 하나
type Show struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Hall         string `json:"hall"`
	Seats        int    `json:"seats"`
	Start        string `json:"start"` // HH:MM
	End          string `json:"end"`   // 종료 예상 HH:MM
	RuntimeMin   int    `json:"runtimeMin"`
	RuntimeKnown bool   `json:"runtimeKnown"`
	Genre        string `json:"genre"`
	Major        bool   `json:"major"` // 2,000석 이상 공연장(예측에 반영)
}

type ForecastBin struct {
	T          string  `json:"t"`
	Level      Level   `json:"level"`
	Ratio      float64 `json:"ratio"`      // 기준 분포의 95분위 = 1
	EventShare float64 `json:"eventShare"` // 공연 영향 비중 0~1
}

type Window struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type AvoidWindow struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Reason string `json:"reason"` // event | usual
}

type ConcertAdvice struct {
	ShowID       string  `json:"showId"`
	ArriveBy     string  `json:"arriveBy"`
	BusyFrom     *string `json:"busyFrom"`
	Start        string  `json:"start"`
	End          string  `json:"end"`
	ExitRush     Window  `json:"exitRush"`
	TransitFirst bool    `json:"transitFirst"`
}

type ParkAdvice struct {
	Best  []Window      `json:"best"`
	Avoid []AvoidWindow `json:"avoid"`
}

type DayWeather struct {
	Sky        *string  `json:"sky"`
	MinTemp    *float64 `json:"minTemp"`
	MaxTemp    *float64 `json:"maxTemp"`
	RainChance *float64 `json:"rainChance"`
	PrecipType *string  `json:"precipType"`
	Source     string   `json:"source"`
}

type Peak struct {
	T     string `json:"t"`
	Level Level  `json:"level"`
}

type Thresholds struct {
	Normal float64 `json:"normal"`
	Busy   float64 `json:"busy"`
	Jam    float64 `json:"jam"`
}

type Forecast struct {
	Bins       []ForecastBin `json:"bins"`
	Peak       Peak          `json:"peak"`
	Thresholds Thresholds    `json:"thresholds"`
}

type Advice struct {
	Concert []ConcertAdvice `json:"concert"`
	Park    ParkAdvice      `json:"park"`
}

type ModelMeta struct {
	Version     string   `json:"version"`
	FitMaeCars  *float64 `json:"fitMaeCars"`
	ExitMinutes int      `json:"exitMinutes"`
	Note        string   `json:"note"`
	// Source 는 예측을 계산한 곳: ml-service(Python AI 서비스) | embedded(Go 내장 모델, AI 서비스가 꺼졌을 때)
	Source string `json:"source"`
}

// ConfigResponse 는 화면이 시작할 때 받는 공개 설정이다(비밀 값은 넣지 않는다).
type ConfigResponse struct {
	NaverMapClientID *string `json:"naverMapClientId"`
}

// ShowItem 은 기간 안 공연 회차 하나(상담 에이전트의 공연 검색용)
type ShowItem struct {
	Date  string `json:"date"`
	Start string `json:"start"`
	End   string `json:"end"`
	Name  string `json:"name"`
	Hall  string `json:"hall"`
	Seats int    `json:"seats"`
	Major bool   `json:"major"`
}

type ShowsResponse struct {
	Shows  []ShowItem        `json:"shows"`
	Errors map[string]string `json:"errors"`
}

type DayResponse struct {
	Date        string            `json:"date"`
	Weekday     string            `json:"weekday"`
	DayType     DayType           `json:"dayType"`
	HolidayName *string           `json:"holidayName"`
	Shows       []Show            `json:"shows"`
	Forecast    Forecast          `json:"forecast"`
	Advice      Advice            `json:"advice"`
	Weather     *DayWeather       `json:"weather"`
	Model       ModelMeta         `json:"model"`
	Errors      map[string]string `json:"errors"`
}

type MajorShow struct {
	Name  string `json:"name"`
	Hall  string `json:"hall"`
	Start string `json:"start"`
	Seats int    `json:"seats"`
}

type OverviewDay struct {
	Date        string      `json:"date"`
	Weekday     string      `json:"weekday"`
	DayType     DayType     `json:"dayType"`
	HolidayName *string     `json:"holidayName"`
	PeakLevel   Level       `json:"peakLevel"`
	PeakTime    string      `json:"peakTime"`
	MajorShows  []MajorShow `json:"majorShows"`
}

type OverviewResponse struct {
	Days   []OverviewDay     `json:"days"`
	Errors map[string]string `json:"errors"`
}

// ── 실시간 ──────────────────────────────

type ParkingPoint struct {
	At  string `json:"at"`
	Sum int    `json:"sum"`
}

type Parking struct {
	Sum   int            `json:"sum"`
	At    string         `json:"at"`
	Today []ParkingPoint `json:"today"`
}

type PopulationForecast struct {
	At    string `json:"at"`
	Level string `json:"level"`
}

type Population struct {
	Level    string               `json:"level"`
	Message  string               `json:"message"`
	Min      int                  `json:"min"`
	Max      int                  `json:"max"`
	At       string               `json:"at"`
	Forecast []PopulationForecast `json:"forecast"`
}

type RoadLink struct {
	ID    string       `json:"id"`
	Name  string       `json:"name"`
	From  string       `json:"from"`
	To    string       `json:"to"`
	Speed float64      `json:"speed"`
	Idx   string       `json:"idx"`  // 원활 | 서행 | 정체
	Path  [][2]float64 `json:"path"` // [경도, 위도]
}

type Road struct {
	Level   string     `json:"level"`
	Speed   float64    `json:"speed"`
	Message string     `json:"message"`
	At      string     `json:"at"`
	Links   []RoadLink `json:"links"`
}

type Weather struct {
	Temp       float64 `json:"temp"`
	Sky        *string `json:"sky"`
	PrecipType string  `json:"precipType"`
	Message    string  `json:"message"`
	PM10Level  string  `json:"pm10Level"`
	At         string  `json:"at"`
}

type ParkingLot struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Capacity int     `json:"capacity"`
	Lat      float64 `json:"lat"`
	Lng      float64 `json:"lng"`
	Address  string  `json:"address"`
	Fee      *string `json:"fee"` // 예: 10분 600원
}

type Station struct {
	Name string  `json:"name"`
	Line string  `json:"line"`
	Lat  float64 `json:"lat"`
	Lng  float64 `json:"lng"`
}

type Control struct {
	ID        string   `json:"id"`
	Kind      string   `json:"kind"`
	Info      string   `json:"info"`
	From      *string  `json:"from"`
	To        *string  `json:"to"`
	DistanceM *int     `json:"distanceM"`
	Lat       *float64 `json:"lat"`
	Lng       *float64 `json:"lng"`
}

type LiveResponse struct {
	FetchedAt  string            `json:"fetchedAt"`
	Parking    *Parking          `json:"parking"`
	Population *Population       `json:"population"`
	Road       *Road             `json:"road"`
	Weather    *Weather          `json:"weather"`
	Lots       []ParkingLot      `json:"lots"`
	Stations   []Station         `json:"stations"`
	Controls   []Control         `json:"controls"`
	Errors     map[string]string `json:"errors"`
}

// Ptr 는 값의 포인터(널 허용 필드용)
func Ptr[T any](v T) *T { return &v }
