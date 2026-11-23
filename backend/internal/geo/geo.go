// Package geo 는 서울시 돌발정보 좌표(GRS80 중부원점 TM, EPSG:5181)와 위경도를 오간다.
// 원점 위도 38°, 경도 127°, 가산값 x 200000 / y 500000.
package geo

import "math"

const (
	a  = 6378137.0
	f  = 1 / 298.257222101
	k0 = 1.0
	x0 = 200000.0
	y0 = 500000.0
)

var (
	e2   = 2*f - f*f
	ep2  = e2 / (1 - e2)
	lat0 = 38 * math.Pi / 180
	lon0 = 127 * math.Pi / 180
	m0   = meridian(lat0)
)

// ParkCenter 는 올림픽공원 중심(KOPIS 시설 좌표 부근)
var ParkCenter = struct{ Lat, Lng float64 }{37.5207, 127.1215}

func meridian(phi float64) float64 {
	e4, e6 := e2*e2, e2*e2*e2
	return a * ((1-e2/4-3*e4/64-5*e6/256)*phi -
		(3*e2/8+3*e4/32+45*e6/1024)*math.Sin(2*phi) +
		(15*e4/256+45*e6/1024)*math.Sin(4*phi) -
		(35*e6/3072)*math.Sin(6*phi))
}

// ToTM 은 위경도를 TM 좌표(미터)로 바꾼다.
func ToTM(lat, lng float64) (x, y float64) {
	phi := lat * math.Pi / 180
	lam := lng * math.Pi / 180
	n := a / math.Sqrt(1-e2*math.Pow(math.Sin(phi), 2))
	t := math.Pow(math.Tan(phi), 2)
	c := ep2 * math.Pow(math.Cos(phi), 2)
	A := (lam - lon0) * math.Cos(phi)
	x = x0 + k0*n*(A+(1-t+c)*math.Pow(A, 3)/6+(5-18*t+t*t+72*c-58*ep2)*math.Pow(A, 5)/120)
	y = y0 + k0*(meridian(phi)-m0+n*math.Tan(phi)*(A*A/2+(5-t+9*c+4*c*c)*math.Pow(A, 4)/24+(61-58*t+t*t+600*c-330*ep2)*math.Pow(A, 6)/720))
	return x, y
}

// FromTM 은 TM 좌표를 위경도로 바꾼다.
func FromTM(x, y float64) (lat, lng float64) {
	m1 := m0 + (y-y0)/k0
	mu := m1 / (a * (1 - e2/4 - 3*e2*e2/64 - 5*math.Pow(e2, 3)/256))
	e1 := (1 - math.Sqrt(1-e2)) / (1 + math.Sqrt(1-e2))
	phi1 := mu + (3*e1/2-27*math.Pow(e1, 3)/32)*math.Sin(2*mu) +
		(21*e1*e1/16-55*math.Pow(e1, 4)/32)*math.Sin(4*mu) +
		(151*math.Pow(e1, 3)/96)*math.Sin(6*mu) +
		(1097*math.Pow(e1, 4)/512)*math.Sin(8*mu)
	c1 := ep2 * math.Pow(math.Cos(phi1), 2)
	t1 := math.Pow(math.Tan(phi1), 2)
	n1 := a / math.Sqrt(1-e2*math.Pow(math.Sin(phi1), 2))
	r1 := a * (1 - e2) / math.Pow(1-e2*math.Pow(math.Sin(phi1), 2), 1.5)
	d := (x - x0) / (n1 * k0)
	phi := phi1 - (n1*math.Tan(phi1)/r1)*(d*d/2-
		(5+3*t1+10*c1-4*c1*c1-9*ep2)*math.Pow(d, 4)/24+
		(61+90*t1+298*c1+45*t1*t1-252*ep2-3*c1*c1)*math.Pow(d, 6)/720)
	lam := lon0 + (d-(1+2*t1+c1)*math.Pow(d, 3)/6+(5-2*c1+28*t1-3*c1*c1+8*ep2+24*t1*t1)*math.Pow(d, 5)/120)/math.Cos(phi1)
	return phi * 180 / math.Pi, lam * 180 / math.Pi
}
