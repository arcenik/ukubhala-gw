#! /bin/bash

BASE="./logs/"

while true
do

echo "==========================================================" | cronolog ${BASE}/%Y-%m/run-%Y-%m-%d.log -S ${BASE}/run.log
echo "[$(date)] Starting ./ukubhala-gw.js" | cronolog ${BASE}/%Y-%m/run-%Y-%m-%d.log -S ${BASE}/run.log
./ukubhala-gw.js 2>&1 | cronolog ${BASE}/%Y-%m/run-%Y-%m-%d.log -S ${BASE}/run.log

done
