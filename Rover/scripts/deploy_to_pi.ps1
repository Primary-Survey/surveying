param(
  [string]$HostName = "raspberrypi.local",
  [string]$User = "primary",
  [string]$RemoteDir = ""
)

$ErrorActionPreference = "Stop"
$LocalDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not $RemoteDir) {
  $RemoteDir = "/home/$User/rtk-rover"
}

Write-Host "Copying Rover folder to $User@$HostName:$RemoteDir ..."
ssh "$User@$HostName" "mkdir -p $RemoteDir"
scp -r "$LocalDir/*" "$User@$HostName`:$RemoteDir/"

Write-Host "Running install script on Raspberry Pi ..."
ssh "$User@$HostName" "cd $RemoteDir && sudo bash scripts/install_rover.sh"

Write-Host "Deployment complete."
