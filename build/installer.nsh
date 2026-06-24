; ============================================================================
;  StealthPOS Connector — installer customizations  (electron-builder auto-includes
;  build/installer.nsh and !insertmacro's any of the macros it defines).
;
;  WHY THIS EXISTS:
;  If a previous version is still running when you install/upgrade, the running
;  Electron GUI locks app.asar and the background service/logon-task node locks
;  node.exe + edge.cjs. electron-builder's default behaviour is to NAG the user
;  ("StealthPOS Connector cannot be closed. Please close it manually and click
;  Retry") — and if that isn't resolved cleanly the upgrade SILENTLY LEAVES STALE
;  CODE behind under the new version number (observed 2026-06-24: a 1.0.7 install
;  kept launching an old signup form because app.asar was never replaced).
;
;  A c-store clerk can't be expected to hunt down processes. So we close
;  everything automatically, up front, so every install is fully clean.
; ============================================================================

!macro stealthCloseRunning
  DetailPrint "Closing any running StealthPOS Connector before installing..."

  ; 1) Background Windows service (nssm). Stopping it terminates its node child
  ;    (which holds node.exe + edge.cjs); deleting it clears the registration so
  ;    the fresh install re-registers from scratch.
  nsExec::Exec 'cmd.exe /c sc stop StealthPOSConnector'
  nsExec::Exec 'cmd.exe /c sc delete StealthPOSConnector'

  ; 2) "Always-on" logon scheduled task. /End terminates its running process tree
  ;    (powershell launcher -> node), /Delete removes it.
  nsExec::Exec 'cmd.exe /c schtasks /End /TN StealthPOSConnector'
  nsExec::Exec 'cmd.exe /c schtasks /Delete /TN StealthPOSConnector /F'

  ; 3) The Electron GUI / setup wizard. THIS is what locks app.asar — the cause of
  ;    the stale-renderer bug. /T also kills its renderer/GPU child processes.
  nsExec::Exec 'cmd.exe /c taskkill /F /T /IM "StealthPOS Connector.exe"'

  ; 4) Give Windows a moment to release the file handles before we overwrite files.
  Sleep 1500
!macroend

; Runs at the very start of the installer's .onInit — BEFORE the old version's
; uninstaller (and its app-running check) is invoked, so that check passes silently.
!macro customInit
  !insertmacro stealthCloseRunning
!macroend

; Make the Windows "Uninstall" path tidy too: stop the service/task before files go.
!macro customUnInit
  !insertmacro stealthCloseRunning
!macroend
