; ============================================================================
;  StealthPOS Connector — installer customizations
;  electron-builder !include's this file (via nsis.include: build/installer.nsh)
;  and !insertmacro's any of the macros it defines.
;
;  WHY: if a previous version is running during install/upgrade, the Electron GUI
;  locks app.asar and the background service/logon-task node locks node.exe +
;  edge.cjs. electron-builder then nags "StealthPOS Connector cannot be closed…"
;  and, if not resolved cleanly, the upgrade silently leaves STALE code behind
;  (observed: a 1.0.7 install kept launching an old signup form). A clerk can't
;  hunt down processes, so we close everything automatically, up front.
;
;  v1.0.8 shipped this logic as customInit but the nag still appeared in testing.
;  v1.0.9: (1) referenced via an EXPLICIT nsis.include (not auto-detect), and
;  (2) writes C:\stealthpos-hook.log so we can VERIFY the hook actually ran.
; ============================================================================

!macro stealthCloseRunning
  ; --- verification marker: if this file appears, the hook executed ---
  nsExec::Exec 'cmd.exe /c echo [stealth install hook ran] >> "C:\stealthpos-hook.log"'

  ; --- background Windows service (nssm): stop frees its node child; delete clears registration ---
  nsExec::Exec 'cmd.exe /c sc stop StealthPOSConnector'
  nsExec::Exec 'cmd.exe /c sc delete StealthPOSConnector'

  ; --- always-on logon scheduled task: /End kills its process tree, /Delete removes it ---
  nsExec::Exec 'cmd.exe /c schtasks /End /TN StealthPOSConnector'
  nsExec::Exec 'cmd.exe /c schtasks /Delete /TN StealthPOSConnector /F'

  ; --- the Electron GUI (locks app.asar): force-kill the whole tree, no USERNAME filter, retried ---
  nsExec::Exec 'cmd.exe /c taskkill /F /T /IM "StealthPOS Connector.exe"'
  Sleep 1200
  nsExec::Exec 'cmd.exe /c taskkill /F /IM "StealthPOS Connector.exe"'
  Sleep 800

  nsExec::Exec 'cmd.exe /c echo [stealth install hook done] >> "C:\stealthpos-hook.log"'
!macroend

; Runs in the installer .onInit, BEFORE the install section's app-running check.
!macro customInit
  !insertmacro stealthCloseRunning
!macroend

; Keep the Windows "Uninstall" path tidy too.
!macro customUnInit
  !insertmacro stealthCloseRunning
!macroend
