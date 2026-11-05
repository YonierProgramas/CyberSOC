; Este candidato no implementa borrado de datos. Ni siquiera acepta el flag
; genérico heredado del builder: evitar una eliminación recursiva sin validar.
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
