; This candidate does not implement data deletion. It does not even accept the generic
; flag inherited from the builder: avoids an unvalidated recursive deletion.
!macro customUnInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--delete-app-data" $R1
  ${IfNot} ${Errors}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "Los datos se conservan. Este instalador no admite borrarlos."
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend
