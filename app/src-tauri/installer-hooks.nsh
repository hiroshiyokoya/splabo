; splabo の NSIS インストーラ調整（#623）
;
; Tauri の installer.nsi は、このファイルを**先頭付近（34 行目あたり）で !include** する。
; 完了ページの挿入（!insertmacro MUI_PAGE_FINISH・416 行目あたり）より前なので、
; ここで !define したものはページの描画に効く。
;
; NSIS_HOOK_PREINSTALL などのマクロは定義していない。テンプレート側は
; !ifmacrodef で見ているので、定義が無ければ何も起きない。

; デスクトップにショートカットを作るチェックを、**既定で外す**。
;
; Tauri は完了ページの「README を表示」ボタンをショートカット作成に転用しており、
; 既定ではチェックが入った状態で表示される。MUI2 はこの定義があるとチェックを
; 外して描画する（Contrib/Modern UI 2/Pages/Finish.nsh の !ifndef 分岐）。
;
; **項目自体は消さない。** 欲しい人はその場でチェックを入れられる。
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
