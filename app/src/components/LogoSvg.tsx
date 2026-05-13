import { useEffect, useState } from 'react'

export function LogoSvg() {
  const [viewW, setViewW] = useState(390)

  useEffect(() => {
    // Fredoka が確実に読み込まれてから canvas で実測
    document.fonts.load('700 68px "Fredoka"', 'geartoon').then(() => {
      const c = document.createElement('canvas')
      const ctx = c.getContext('2d')!
      ctx.font = '700 68px "Fredoka", "Hiragino Maru Gothic ProN", sans-serif'
      setViewW(Math.ceil(ctx.measureText('geartoon').width))
    })
  }, [])

  return (
    <svg
      viewBox={`0 0 ${viewW} 76`}
      height="68"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="geartoon"
      role="img"
      style={{ display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="logo-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#4d8bff" />
          <stop offset="100%" stopColor="#fedc0c" />
        </linearGradient>
      </defs>

      {/* ピンクインク スプラット（"on"の背面） */}
      <g fill="#ff66ff" opacity="0.95" transform="translate(313,26) scale(0.66) translate(-313,-38)">
        <path d="M313,12 C322,6 335,9 338,20 C347,15 350,27 343,36 C351,44 346,58 335,60 C332,68 320,69 313,61 C302,69 290,61 290,50 C281,48 278,38 285,30 C277,21 282,9 294,9 C296,2 310,1 313,12Z" />
        <ellipse cx="307" cy="0"   rx="6"  ry="4"  transform="rotate(-20,307,0)" />
        <ellipse cx="327" cy="-6"  rx="4"  ry="3"  transform="rotate(10,327,-6)" />
        <ellipse cx="291" cy="2"   rx="3"  ry="2"  />
        <ellipse cx="339" cy="1"   rx="5"  ry="3"  transform="rotate(-10,339,1)" />
        <ellipse cx="357" cy="20"  rx="7"  ry="5"  transform="rotate(-20,357,20)" />
        <ellipse cx="363" cy="40"  rx="4"  ry="6"  transform="rotate(15,363,40)" />
        <ellipse cx="355" cy="56"  rx="3"  ry="3"  />
        <ellipse cx="330" cy="80"  rx="6"  ry="4"  transform="rotate(10,330,80)" />
        <ellipse cx="307" cy="84"  rx="4"  ry="3"  />
        <ellipse cx="287" cy="78"  rx="3"  ry="5"  transform="rotate(-15,287,78)" />
        <ellipse cx="271" cy="54"  rx="5"  ry="4"  transform="rotate(20,271,54)" />
        <ellipse cx="267" cy="32"  rx="4"  ry="3"  />
        <ellipse cx="275" cy="16"  rx="3"  ry="4"  transform="rotate(-10,275,16)" />
        <ellipse cx="369" cy="10"  rx="3"  ry="2"  />
        <ellipse cx="297" cy="-14" rx="2"  ry="2"  transform="rotate(20,297,-14)" />
        <ellipse cx="265" cy="76"  rx="2"  ry="2"  />
        <ellipse cx="351" cy="74"  rx="2"  ry="2"  transform="rotate(-10,351,74)" />
      </g>

      <text
        x="0"
        y="62"
        fontFamily="'Fredoka', 'Hiragino Maru Gothic ProN', 'Hiragino Maru Gothic Pro', sans-serif"
        fontWeight="700"
        fontSize="68"
        letterSpacing="1"
        fill="url(#logo-grad)"
      >
        geartoon
      </text>
    </svg>
  )
}
