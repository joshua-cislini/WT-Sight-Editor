@echo off
title WT Reticle Studio - Live Sights Folder Watcher
echo Synchronizing sights/ folder and launching WT Reticle Studio...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sync-sights.ps1" -OpenBrowser -Watch
