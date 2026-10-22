/**
 * ギア名の改行位置（#886）。
 *
 * ギア名は「本体名 + 色・型の名前」の組み合わせが多い（タカアシプロテクター|ライム、トレッキング|カスタム）。
 * 辞書は持たず、ギア一覧そのものから切れ目を推定する:
 *
 * - 他のギア名と頭が共通する部分の終わり（そこから先が名前ごとに違う）
 * - 他のギア名と末尾が共通する部分の始まり
 *
 * 切れ目にはゼロ幅スペースを入れる。CSS の `word-break: keep-all` と組み合わせると、
 * 2 行になるときに切れ目でだけ改行する。テキストノードは 1 つのままなので、
 * PNG 書き出しの「…」焼き込み（bakeLineClampEllipsis）もそのまま効く。
 */

/** 共通部分とみなす最短の文字数。2 文字だと「ット」「ッド」のような偶然の一致が多すぎる */
const MIN_PART = 3

/** この文字の前では切らない（長音・促音・小書きの仮名） */
const NO_BREAK_BEFORE = 'ーッァィゥェォャュョヮヵヶっぁぃぅぇぉゃゅょ'

/** この文字の後では切らない */
const NO_BREAK_AFTER = 'ッっ'

/** もともと切れ目になる文字（この後で切る） */
const SEPARATORS = '・ 　'

const ZWSP = '​'

let measureCtx: CanvasRenderingContext2D | null | undefined

/**
 * 切れ目で区切った切れ端のうち、いちばん長いものの幅（px・#888）。
 *
 * 切れ端が 1 行に入らないと、`word-break: keep-all` のままでは `overflow-wrap: anywhere` の
 * 非常改行で行末ぎりぎりで切られ、禁則も効かない（タカアシプロテクタ／ーライム）。
 * 呼び出し側はこの幅と欄の幅を比べて、文字を縮めるか、ふつうの折り返しに戻す。
 *
 * フォントの種類は el の算出スタイル、大きさは fontSizePx で測る（縮めたあとの大きさで
 * 測り直して、縮め続けないように）。測れないときは 0。
 */
export function longestSegmentWidth(el: HTMLElement, broken: string, fontSizePx: number): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  const cs = getComputedStyle(el)
  measureCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSizePx}px ${cs.fontFamily}`
  const ctx = measureCtx
  return Math.max(0, ...broken.split(/[​ 　]/).map(seg => ctx.measureText(seg).width))
}

const isAsciiAlnum = (c: string) => /^[0-9A-Za-z]$/.test(c)

function addCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/**
 * ギア名の一覧から、名前に切れ目（ゼロ幅スペース）を入れる関数を作る。
 * 一覧を読み込んだときに 1 回だけ作る（数ミリ秒）。結果は保存しない。
 */
export function buildNameBreaker(names: Iterable<string>): (name: string) => string {
  const unique = [...new Set(names)]
  // 頭から / 末尾からの部分（MIN_PART 文字以上）ごとに、それを持つ名前の数
  const prefixCount = new Map<string, number>()
  const suffixCount = new Map<string, number>()
  for (const name of unique) {
    const chars = [...name]
    for (let len = MIN_PART; len <= chars.length; len++) {
      addCount(prefixCount, chars.slice(0, len).join(''))
      addCount(suffixCount, chars.slice(chars.length - len).join(''))
    }
  }
  // 自分自身も数に入っているので 1 引く（＝自分以外で共通する名前の数）
  const others = (map: Map<string, number>, key: string) => (map.get(key) ?? 1) - 1

  const cache = new Map<string, string>()

  return (name: string) => {
    const hit = cache.get(name)
    if (hit !== undefined) return hit

    const chars = [...name]
    const L = chars.length
    // 切れ目の位置 i（chars[i] の前で切る）→ 強さ（共通するギアの数）
    const strength = new Map<number, number>()
    for (let i = MIN_PART; i <= L - MIN_PART; i++) {
      const before = chars[i - 1]
      const after = chars[i]
      if (NO_BREAK_BEFORE.includes(after) || NO_BREAK_AFTER.includes(before)) continue
      // 英数字の途中では切らない（英語名・型番）
      if (isAsciiAlnum(before) && isAsciiAlnum(after)) continue
      const pre = chars.slice(0, i).join('')
      const suf = chars.slice(i).join('')
      const preN = others(prefixCount, pre)
      const sufN = others(suffixCount, suf)
      let s = 0
      // 1 文字延ばすと共通する名前が減る＝共通部分がここで終わる
      if (preN > 0 && others(prefixCount, pre + after) < preN) s += preN
      if (sufN > 0 && others(suffixCount, before + suf) < sufN) s += sufN
      if (s > 0) strength.set(i, s)
    }
    chars.forEach((c, i) => {
      if (SEPARATORS.includes(c) && i + 1 < L) strength.set(i + 1, Infinity)
    })

    // 1 文字だけの切れ端ができたら、弱いほうの切れ目を捨てる
    const breaks = [...strength.keys()].sort((a, b) => a - b)
    for (let k = 1; k < breaks.length;) {
      if (breaks[k] - breaks[k - 1] < 2) {
        const dropLater = (strength.get(breaks[k]) ?? 0) < (strength.get(breaks[k - 1]) ?? 0)
        breaks.splice(dropLater ? k : k - 1, 1)
        k = Math.max(1, k - 1)
      } else {
        k++
      }
    }

    // 空白の直後は、空白自体が切れ目になるので入れない
    const at = new Set(breaks.filter(i => chars[i - 1] !== ' ' && chars[i - 1] !== '　'))
    const result = chars.map((c, i) => (at.has(i) ? ZWSP : '') + c).join('')
    cache.set(name, result)
    return result
  }
}
