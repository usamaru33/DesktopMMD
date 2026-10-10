; electron-builder の NSIS に差し込むマクロ（electron-builder.yml の nsis.include）。
; アンインストール時に、Windows ログイン時の自動起動の登録（src/main/system/autoLaunch.ts の LOGIN_ITEM_NAME）を消す。
; 更新インストール（古い版のアンインストールが裏で走る）のときは消さない。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DesktopMMD"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "DesktopMMD"
  ${endIf}
!macroend
