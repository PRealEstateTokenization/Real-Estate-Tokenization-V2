#!/usr/bin/env bash
# Parcel — one-command startup
set -e

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
say(){ printf "${C}==>${N} %s\n" "$1"; }
ok(){  printf "${G} ok${N} %s\n" "$1"; }
warn(){ printf "${Y} !!${N} %s\n" "$1"; }

cd "$(dirname "$0")"
CHAIN_LOG="/tmp/parcel-chain.log"
CHAIN_PID=""; SERVE_PID=""

cleanup(){
  echo; say "Shutting down..."
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null || true
  [ -n "$CHAIN_PID" ] && kill "$CHAIN_PID" 2>/dev/null || true
  ok "Stopped. Bye."; exit 0
}
trap cleanup INT TERM

if [ ! -d node_modules ]; then
  say "Installing dependencies (first run only)..."; npm install
fi

free_port(){
  if command -v lsof >/dev/null 2>&1; then
    local pids; pids=$(lsof -ti:"$1" 2>/dev/null || true)
    if [ -n "$pids" ]; then
      warn "Port $1 busy — clearing it."
      echo "$pids" | xargs kill -9 2>/dev/null || true; sleep 1
    fi
  fi
}
free_port 8545
free_port 3000

say "Starting local blockchain..."
npx hardhat node > "$CHAIN_LOG" 2>&1 &
CHAIN_PID=$!

printf "    waiting for chain"
for i in $(seq 1 30); do
  if curl -s -X POST -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
      http://127.0.0.1:8545 >/dev/null 2>&1; then
    echo; ok "Blockchain running (pid $CHAIN_PID) — log: $CHAIN_LOG"; break
  fi
  printf "."; sleep 1
  if [ "$i" -eq 30 ]; then
    echo; printf "${R}Chain failed to start. Last lines of log:${N}\n"
    tail -15 "$CHAIN_LOG"; cleanup
  fi
done

say "Deploying contracts + seeding demo data..."
if ! npx hardhat run scripts/deploy.js --network localhost; then
  printf "${R}Deploy failed.${N}\n"; cleanup
fi
ok "Contracts deployed and seeded."

say "Wiring config into the frontend..."
cp frontend-config/addresses.json frontend/addresses.json
cp frontend-config/abis.json frontend/abis.json
ok "Config copied."

say "Starting the web server..."
( cd frontend && npx serve . -l 3000 > /tmp/parcel-serve.log 2>&1 ) &
SERVE_PID=$!
sleep 2

echo
printf "${G}============================================${N}\n"
printf "${G}  Parcel is running!${N}\n"
printf "${G}  Open:  ${C}http://localhost:3000${N}\n"
printf "${G}============================================${N}\n"
echo
printf "  Demo logins (all password: ${Y}demo1234${N}):\n"
printf "    alice@parcel.demo   (property owner)\n"
printf "    bob@parcel.demo     (investor)\n"
printf "    carol@parcel.demo   (investor)\n"
echo
printf "  ${Y}Press Ctrl+C here to stop everything.${N}\n"
echo
wait
