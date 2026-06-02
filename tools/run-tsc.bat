@echo off
set NODE_HOME=D:\mycode\Z Code\tools\node-v20.14.0-win-x64
set PATH=%NODE_HOME%;%PATH%
cd /d D:\mycode\Z Code\extensions\coding-agent
%NODE_HOME%\npx.cmd tsc -p ./
