Unicode true
!include "MUI2.nsh"
!ifndef VERSION
!error "VERSION is required"
!endif
Name "Tiemvio POS"
OutFile "..\..\release\Tiemvio-POS-Windows.exe"
InstallDir "$LOCALAPPDATA\Programs\TiemvioPOS"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Tiemvio POS"
VIAddVersionKey /LANG=1033 "FileDescription" "Tiemvio POS installer"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Nguyễn Giang Bảo"
!define MUI_ICON "app.ico"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Section "Tiemvio POS"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  IfFileExists "$INSTDIR\TiemvioPOS.exe" 0 stopped
  ExecWait '$\"$INSTDIR\TiemvioPOS.exe$\" --stop-updater'
  Sleep 1500
  stopped:
  SetOverwrite on
  ClearErrors
  File "publish\TiemvioPOS.exe"
  IfErrors 0 installed
  Abort "Tiemvio POS could not update the launcher. Please close its background updater and retry."
  installed:
  SetOutPath "$INSTDIR\licenses"
  File /r "..\licenses\*"
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Tiemvio POS.lnk" "$INSTDIR\TiemvioPOS.exe"
  CreateDirectory "$SMPROGRAMS\Tiemvio POS"
  CreateShortcut "$SMPROGRAMS\Tiemvio POS\Tiemvio POS.lnk" "$INSTDIR\TiemvioPOS.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TiemvioPOS Updates" '$\"$INSTDIR\TiemvioPOS.exe$\" --background'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiemvioPOS" "DisplayName" "Tiemvio POS"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiemvioPOS" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiemvioPOS" "DisplayIcon" "$INSTDIR\TiemvioPOS.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiemvioPOS" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiemvioPOS" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiemvioPOS" "NoRepair" 1
  IfSilent background
  Exec '$\"$INSTDIR\TiemvioPOS.exe$\"'
  Goto done
  background:
  Exec '$\"$INSTDIR\TiemvioPOS.exe$\" --background'
  done:
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  ExecWait '$\"$INSTDIR\TiemvioPOS.exe$\" --stop-updater'
  Sleep 1500
  ; Never close Edge or clear shop data.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "TiemvioPOS Updates"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\TiemvioPOS"
  Delete "$DESKTOP\Tiemvio POS.lnk"
  Delete "$SMPROGRAMS\Tiemvio POS\Tiemvio POS.lnk"
  RMDir "$SMPROGRAMS\Tiemvio POS"
  Delete /REBOOTOK "$INSTDIR\TiemvioPOS.exe"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
