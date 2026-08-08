// 環境分析タブ（EnvAnalysis）の選択状態を localStorage に永続化する（#407）。
//
// タブ切替で EnvAnalysis がアンマウントされると useState が全部リセットされ、
// グラフの設定（可視化モード・集計軸・X/Y・ログスケール・サイズ/色指標・セル指標・
// 各種フィルタ・期間）が初期状態に戻ってしまう。これを防ぐため、選択状態を 1 キー
// （`splabo:shellEnv`）に JSON でまとめて保存し、mount 時に復元する。
// viewPrefs / customCharts と同じ作法（1 キー・store ミラー・安全フォールバック）。
//
// 取得状況（status）や読み込み済みデータ（scatterData / matrixData）は永続化しない
// （毎回取り直す）。

import { SHELL_ENV_KEY, lsGet, mirrorToStore } from './settingsStore'

/** 永続化する選択状態。値の型は緩め（string）にしておき、復元時に既定へ安全に落とす。 */
export interface EnvPrefs {
  vizMode:     'scatter' | 'heatmap'
  groupBy:     'weapon' | 'stage'
  xKey:        string
  yKey:        string
  /** 散布図のサイズ指標（#406）。'' = なし。 */
  sizeKey:     string
  /** 散布図の色指標（#406）。'' = なし。 */
  colorKey:    string
  /** 散布図 X 軸をログスケールにするか（#473）。 */
  xLog:        boolean
  /** 散布図 Y 軸をログスケールにするか（#473）。 */
  yLog:        boolean
  rowDim:      string
  colDim:      string
  cellMetric:  string
  period:      string
  customSince: string
  customUntil: string
  /** 名指しで選んだシーズン名（`period === 'season'` のときだけ意味を持つ・#585）。 */
  seasonName:  string
  /**
   * 表示するブキ（#593）。空なら全部出す。
   *
   * `weaponKeys`（共通フィルタ）とは別物。あちらは母集団を絞り、こちらは表示だけを絞る。
   */
  displayWeapons: string[]
  lobbyKeys:   string[]
  ruleKeys:    string[]
  /** ブキキー（weapon.key）複数。空 = 絞り込まない（#477）。 */
  weaponKeys:  string[]
  /** ステージキー（map.key）複数。空 = 絞り込まない（#477）。 */
  stageKeys:   string[]
  gameVers:    string[]
  posterRanks: string[]
  powerMin:    string
  powerMax:    string
}

export const DEFAULT_ENV_PREFS: EnvPrefs = {
  vizMode:     'scatter',
  groupBy:     'weapon',
  xKey:        'pick_rate',
  yKey:        'win_rate',
  sizeKey:     '',
  colorKey:    '',
  xLog:        false,
  yLog:        false,
  rowDim:      'weapon',
  colDim:      'stage',
  cellMetric:  'win_rate',
  period:      '30d',
  customSince: '',
  customUntil: '',
  seasonName:  '',
  displayWeapons: [],
  lobbyKeys:   [],
  ruleKeys:    [],
  weaponKeys:  [],
  stageKeys:   [],
  gameVers:    [],
  posterRanks: [],
  powerMin:    '',
  powerMax:    '',
}

/** 値が string の配列であることを保証する（壊れた値は既定へ落とす）。 */
function strArray(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? v as string[] : fallback
}
/** string であることを保証する。 */
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}
/** boolean であることを保証する（キーが無い旧データは既定へ落ちる）。 */
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/**
 * localStorage から復元する。壊れた値・欠けたキーは既定へ安全に落とす。
 * 列挙値（vizMode / groupBy）は許容集合でチェックし、外れていれば既定にする。
 */
export function loadEnvPrefs(): EnvPrefs {
  try {
    const raw = lsGet(SHELL_ENV_KEY)
    if (!raw) return DEFAULT_ENV_PREFS
    const p = JSON.parse(raw)
    if (typeof p !== 'object' || p === null) return DEFAULT_ENV_PREFS
    const d = DEFAULT_ENV_PREFS
    return {
      vizMode:     p.vizMode === 'heatmap' ? 'heatmap' : 'scatter',
      groupBy:     p.groupBy === 'stage' ? 'stage' : 'weapon',
      xKey:        str(p.xKey, d.xKey),
      yKey:        str(p.yKey, d.yKey),
      sizeKey:     str(p.sizeKey, d.sizeKey),
      colorKey:    str(p.colorKey, d.colorKey),
      xLog:        bool(p.xLog, d.xLog),
      yLog:        bool(p.yLog, d.yLog),
      rowDim:      str(p.rowDim, d.rowDim),
      colDim:      str(p.colDim, d.colDim),
      cellMetric:  str(p.cellMetric, d.cellMetric),
      // 🔴 過去のビルドが書いた `'season'` をここで畳む。
      // この値は v0.9.10 以前が知らず、switch がどれにも当たらずに落ちる。
      // 新しいビルドは seasonName の有無でシーズン指定を復元するので、
      // ここで custom に均しても表示は変わらない。
      period:      p.period === 'season' ? 'custom' : str(p.period, d.period),
      customSince: str(p.customSince, d.customSince),
      customUntil: str(p.customUntil, d.customUntil),
      seasonName:  str(p.seasonName, d.seasonName),
      displayWeapons: strArray(p.displayWeapons, d.displayWeapons),
      lobbyKeys:   strArray(p.lobbyKeys, d.lobbyKeys),
      ruleKeys:    strArray(p.ruleKeys, d.ruleKeys),
      weaponKeys:  strArray(p.weaponKeys, d.weaponKeys),
      stageKeys:   strArray(p.stageKeys, d.stageKeys),
      gameVers:    strArray(p.gameVers, d.gameVers),
      posterRanks: strArray(p.posterRanks, d.posterRanks),
      powerMin:    str(p.powerMin, d.powerMin),
      powerMax:    str(p.powerMax, d.powerMax),
    }
  } catch {
    return DEFAULT_ENV_PREFS
  }
}

/** localStorage に保存し、store（settings.json）へもミラーする（#241 と同じ作法）。 */
export function saveEnvPrefs(prefs: EnvPrefs): void {
  localStorage.setItem(SHELL_ENV_KEY, JSON.stringify(prefs))
  void mirrorToStore()
}
