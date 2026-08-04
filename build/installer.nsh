; Pingly writes hooks into the user's agent configs. If the app is removed without
; taking them back out, every agent then shells out to a shim that no longer exists
; and errors on every turn. Undo the wiring before the files go.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DetailPrint "Removing Pingly's hooks from your AI agents..."
    nsExec::ExecToLog '"$INSTDIR\Pingly.exe" --unwire-all'
    Pop $0
    RMDir /r "$LOCALAPPDATA\Pingly"
  ${endIf}
!macroend
