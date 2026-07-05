export function InkBackground() {
  return (
    <svg
      className="ink-background"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      viewBox="0 0 1000 110"
      preserveAspectRatio="xMidYMid slice"
    >
      {/* メインの大きなスプラット（右寄り） */}
      <g fill="#f40dbc" opacity="0.18">
        <path d="M780,18 C796,4 822,8 832,26 C848,16 858,36 844,52 C862,64 850,88 828,90 C824,108 800,112 784,96 C762,112 738,100 736,80 C716,82 706,62 720,48 C706,34 716,10 736,8 C740,-6 768,-6 780,18Z" />
        {/* 飛び散り小粒 */}
        <ellipse cx="868" cy="24" rx="9" ry="7" transform="rotate(-20,868,24)" />
        <ellipse cx="882" cy="55" rx="6" ry="5" />
        <ellipse cx="856" cy="98" rx="8" ry="6" transform="rotate(15,856,98)" />
        <ellipse cx="718" cy="14" rx="5" ry="7" transform="rotate(-10,718,14)" />
      </g>

      {/* 中サイズのスプラット（右端） */}
      <g fill="#f40dbc" opacity="0.14">
        <path d="M920,10 C932,0 952,4 958,18 C970,12 976,28 966,40 C978,50 970,68 954,70 C950,82 934,85 924,74 C908,84 892,74 892,58 C880,56 875,42 884,33 C876,22 882,6 898,6 C900,-4 916,-4 920,10Z" />
        <ellipse cx="978" cy="30" rx="6" ry="5" transform="rotate(10,978,30)" />
        <ellipse cx="887" cy="80" rx="5" ry="4" />
      </g>

      {/* 小さいスプラット（右端外） */}
      <g fill="#f40dbc" opacity="0.12">
        <path d="M970,52 C976,44 988,46 990,56 C998,52 1002,62 994,70 C1002,76 996,88 984,89 C982,97 972,99 966,92 C956,99 946,93 946,83 C938,82 934,74 940,68 C933,61 936,50 946,48 C948,41 964,41 970,52Z" />
        <ellipse cx="1003" cy="58" rx="5" ry="4" />
      </g>
    </svg>
  )
}
