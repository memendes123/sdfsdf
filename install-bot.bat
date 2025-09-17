@echo off
color 0b
title Rep4Rep Bot - Instalador

cls
echo =============================================
echo   Instalador Rep4Rep Bot
echo =============================================
echo.
echo 1^) Instalar em PC local
echo 2^) Instalar em VPS/Servidor
set /p opt=Escolhe uma opcao [1-2]: 
if "%opt%"=="1" goto INSTALL
if "%opt%"=="2" goto INSTALL
echo Opcao invalida.
pause
exit /b 1

:INSTALL
echo.
echo [1/3] Preparando arquivo .env...
if not exist .env (
    copy env.example .env >nul
)
echo [2/3] Instalando dependencias do bot...
call npm install
if errorlevel 1 goto ERROR

echo [3/3] Instalando dependencias do painel...
pushd web
call npm install
if errorlevel 1 goto ERROR
popd

echo.
echo Instalacao concluida! Ajuste o arquivo .env antes de iniciar o bot.
pause
exit /b 0

:ERROR
echo.
echo Ocorreu um erro durante a instalacao. Verifique as mensagens acima.
pause
exit /b 1
