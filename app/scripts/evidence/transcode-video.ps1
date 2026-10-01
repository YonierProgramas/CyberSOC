param(
    [Parameter(Mandatory=$true)][string]$SourcePath,
    [Parameter(Mandatory=$true)][string]$DestinationPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType=WindowsRuntime]
$null = [Windows.Media.Transcoding.MediaTranscoder, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media, ContentType=WindowsRuntime]

function Wait-Operation($Operation, [Type]$ResultType) {
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
        $_.GetGenericArguments().Length -eq 1 -and $_.GetParameters().Length -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    if (-not $task.Wait(60000)) { throw 'Tiempo agotado en Windows Media Transcoder.' }
    return $task.Result
}

$source = Wait-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($SourcePath)) ([Windows.Storage.StorageFile])
$folder = Wait-Operation ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([System.IO.Path]::GetDirectoryName($DestinationPath))) ([Windows.Storage.StorageFolder])
$destination = Wait-Operation ($folder.CreateFileAsync([System.IO.Path]::GetFileName($DestinationPath), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])
$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateMp4([Windows.Media.MediaProperties.VideoEncodingQuality]::HD720p)
$profile.Video.Bitrate = 1500000
$transcoder = New-Object Windows.Media.Transcoding.MediaTranscoder
$prepared = Wait-Operation ($transcoder.PrepareFileTranscodeAsync($source, $destination, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
if (-not $prepared.CanTranscode) { throw "Windows no puede convertir el video: $($prepared.FailureReason)." }
$operation = $prepared.TranscodeAsync()
$method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and
    $_.GetGenericArguments().Length -eq 1 -and $_.GetParameters().Length -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1'
} | Select-Object -First 1
$task = $method.MakeGenericMethod([double]).Invoke($null, @($operation))
if (-not $task.Wait(60000)) { throw 'Tiempo agotado al codificar MP4.' }
if ((Get-Item -LiteralPath $DestinationPath).Length -lt 1024) { throw 'MP4 vacío.' }
$properties = Wait-Operation ($destination.Properties.GetVideoPropertiesAsync()) ([Windows.Storage.FileProperties.VideoProperties])
if ($properties.Duration.TotalSeconds -le 0 -or $properties.Width -le 0) { throw 'MP4 sin fotogramas.' }
[Console]::WriteLine("MP4 generado: $($properties.Width)x$($properties.Height), $($properties.Duration.TotalSeconds) segundos.")
