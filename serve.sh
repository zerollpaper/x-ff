#!/bin/zsh
# x-ff を常駐させるときの起動スクリプト（launchd などから呼ぶ。手で ./serve.sh と打っても動く）。
# 同じ Wi-Fi のスマホからも使えるよう --lan を付ける（合言葉は data/.lan-token）。
# --watch でダウンロードフォルダを見張り、xporter の JSON を自動で取り込む。
# 止めるときは、このスクリプトに TERM を送る（サーバーも一緒に止まる）。
cd "${0:A:h}" || exit 1
# launchd の PATH には nvm の node が入っていないので、なければ nvm を読み込んで探す
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
fi
node --disable-warning=ExperimentalWarning src/server.js --lan --watch &
server=$!
# サーバーが動いている間は Mac がスリープしないようにする（スマホから使えなくなるのを防ぐ）
/usr/bin/caffeinate -i -w $server &
trap 'kill $server 2>/dev/null; wait $server; exit 0' TERM INT HUP
wait $server
