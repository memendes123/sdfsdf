@echo off
color 0b
title Rep4Rep Bot - Inicializador

:MENU
cls
echo =============================================
echo   Iniciar Rep4Rep Bot
echo =============================================
echo.
echo 1^) Apenas terminal (CLI)
echo 2^) Terminal + Painel (abre navegador)
echo 3^) Terminal + Painel (sem abrir navegador)
echo 4^) Sair
set /p opt=Escolhe uma opcao [1-4]: 
if "%opt%"=="1" goto CLI
if "%opt%"=="2" goto BOTH
if "%opt%"=="3" goto BOTH_HEADLESS
if "%opt%"=="4" exit /b 0
echo Opcao invalida.
pause
goto MENU

:CLI
cls
echo Iniciando apenas a CLI...
call node main.cjs
pause
goto MENU

:BOTH
cls
echo Iniciando CLI + Painel...
call node start.js
pause
goto MENU

:BOTH_HEADLESS
cls
echo Iniciando CLI + Painel (sem abrir navegador)...
call node start.js --no-browser
pause
goto MENU
