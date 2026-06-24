; ============================================================================
;  StealthPOS Connector — installer customizations
;  electron-builder !include's this file (via nsis.include: build/installer.nsh)
;  and !insertmacro's any of the macros it defines.
;
;  WHY: if a previous version is running during install/upgrade, the Electron GUI
;  locks app.asar and the background service/logon-task node locks node.exe +
;  edge.cjs. electron-builder then nags "StealthPOS Connector cannot be closed…"
;  and, if not resolved cleanly, the upgrade silently leaves STALE code behind.
;  A clerk can't hunt down processes, so we close everything automatically here,
;  in .onInit, BEFORE the install section's app-running check runs.
;
;  NOTE: the EXPLICIT `nsis.include: build/installer.nsh` in electron-builder.yml
;  is load-bearing — relying on electron-builder's auto-detection of this file
;  silently failed (v1.0.8 still nagged; v1.0.9 with the explicit include works,
;  verified on a real upgrade-over-running-instance 2026-06-24).
; ============================================================================

!macro stealthCloseRunning
  ; background Windows service (nssm): stop frees its node child; delete clears registration
  nsExec::Exec 'cmd.exe /c sc stop StealthPOSConnector'
  nsExec::Exec 'cmd.exe /c sc delete StealthPOSConnector'

  ; always-on logon scheduled task: /End kills its process tree, /Delete removes it
  nsExec::Exec 'cmd.exe /c schtasks /End /TN StealthPOSConnector'
  nsExec::Exec 'cmd.exe /c schtasks /Delete /TN StealthPOSConnector /F'

  ; the Electron GUI (locks app.asar): force-kill the whole tree, no USERNAME filter, retried
  nsExec::Exec 'cmd.exe /c taskkill /F /T /IM "StealthPOS Connector.exe"'
  Sleep 1200
  nsExec::Exec 'cmd.exe /c taskkill /F /IM "StealthPOS Connector.exe"'
  Sleep 800
!macroend

; Runs in the installer .onInit, BEFORE the install section's app-running check.
!macro customInit
  !insertmacro stealthCloseRunning
!macroend

; Keep the Windows "Uninstall" path tidy too.
!macro customUnInit
  !insertmacro stealthCloseRunning
!macroend
